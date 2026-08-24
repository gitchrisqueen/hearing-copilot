# The speaker-identification core: per-chunk embeddings (sherpa-onnx) + named profiles + online
# clustering. This module is deliberately UI-free and server-free; Phase 1 wraps it in the local
# speaker-server.py sidecar, and replay.py drives it directly for the bake-off. Decision policy
# comes from SPEAKER-AUTO-ID-PLAN.md sections 7.2 and 9.4:
#   - two thresholds: >= accept auto-assigns, >= suggest shows a chip, below parks as unknown
#     or spawns a new cluster (only when the chunk is long enough to trust)
#   - the best match must also beat the runner-up by min_margin_pct (ambiguous = never auto)
#   - profile centroids learn only from confident, long-enough chunks (EMA), so one bad chunk
#     cannot drag a profile ("improve instead of rot")

import json
import os
import tempfile
from collections import deque

import numpy as np
import sherpa_onnx


class Profile:
    def __init__(self, pid, name, emb, enrolled=False, speaker=None, n=1):
        self.pid = pid                  # stable id, e.g. "V1" or "enroll:judge"
        self.name = name                # display name or None until labeled
        self.speaker = speaker          # party id ("court"/"plaintiff"/...) or None until labeled
        self.centroid = emb / np.linalg.norm(emb)
        self.n = n                      # chunks absorbed (reporting only)
        self.enrolled = enrolled        # came from explicit enrollment audio

    def absorb(self, emb, ema):
        c = (1.0 - ema) * self.centroid + ema * (emb / np.linalg.norm(emb))
        self.centroid = c / np.linalg.norm(c)
        self.n += 1

    @property
    def persistent(self):
        # Named or party-assigned profiles are the ones worth keeping across hearings.
        # Anonymous session clusters (V1..Vn nobody tagged) die with the session.
        return bool(self.name or self.speaker)

    def to_dict(self):
        return dict(pid=self.pid, name=self.name, speaker=self.speaker,
                    n=self.n, enrolled=self.enrolled,
                    centroid=[round(float(x), 6) for x in self.centroid])

    @classmethod
    def from_dict(cls, d):
        return cls(d["pid"], d.get("name"), np.array(d["centroid"], dtype=np.float32),
                   enrolled=bool(d.get("enrolled")), speaker=d.get("speaker"),
                   n=int(d.get("n", 1)))


class SpeakerEngine:
    def __init__(self, model_path, num_threads=2, accept=0.65, suggest=0.45,
                 min_margin_pct=15.0, ema=0.10, min_train_ms=1500, min_spawn_ms=2000,
                 provider="cpu", poison_every=0):
        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=model_path, num_threads=num_threads, provider=provider)
        if not cfg.validate():
            raise ValueError("bad speaker embedding model config: " + model_path)
        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
        self.accept = accept
        self.suggest = suggest
        self.min_margin_pct = min_margin_pct
        self.ema = ema
        self.min_train_ms = min_train_ms
        self.min_spawn_ms = min_spawn_ms
        self.profiles = []
        self._next_cluster = 1
        self.poison_every = poison_every    # eval only: every Nth train goes to the runner-up
        self._trains = 0
        # Recent chunk embeddings by ts, so a user correction arriving seconds later
        # (/confirm) can still train on the exact audio it is about. ~600 = a 90 min hearing.
        self._recent = deque(maxlen=600)

    # ----- embedding -----
    # Empirical finding (bake-off, July 2026): the sherpa-onnx CAM++ export returns garbage
    # embeddings for certain input DURATIONS (e.g. 3 s, 5 s, 7 s, 8.5 s, 15 s are broken while
    # 2/4/6/8/10/12/20 s are fine, independent of content). Variable-length VAD chunks therefore
    # embedded as noise about half the time. The fix: every embedding input is standardized to a
    # fixed known-good length. Longer audio is center-cropped, shorter audio is tiled (repetition
    # preserves the voice; zero-padding does not). Keep this in the sidecar port.
    EMBED_SAMPLES = 96000   # 6.0 s at 16 kHz

    def _standardize(self, samples):
        n = len(samples)
        if n >= self.EMBED_SAMPLES:
            off = (n - self.EMBED_SAMPLES) // 2
            return samples[off:off + self.EMBED_SAMPLES]
        reps = int(np.ceil(self.EMBED_SAMPLES / max(1, n)))
        return np.tile(samples, reps)[:self.EMBED_SAMPLES]

    def embed(self, samples, sample_rate=16000):
        s = self.extractor.create_stream()
        s.accept_waveform(sample_rate=sample_rate, waveform=self._standardize(samples))
        s.input_finished()
        emb = np.array(self.extractor.compute(s), dtype=np.float32)
        return emb / np.linalg.norm(emb)

    # ----- profile management -----
    def enroll(self, name, sample_list, sample_rate=16000):
        """Build (or extend) a named profile from clean single-speaker clips.
        Clips shorter than 1 s are skipped (too little phonetic coverage to enroll from);
        returns None when nothing usable remains."""
        usable = [s for s in sample_list if len(s) >= sample_rate]
        if not usable:
            return None
        # Long clips contribute every 6 s window, not just their center crop.
        embs = []
        for s in usable:
            for off in range(0, max(1, len(s) - self.EMBED_SAMPLES // 2), self.EMBED_SAMPLES):
                embs.append(self.embed(s[off:off + self.EMBED_SAMPLES], sample_rate))
        emb = np.mean(embs, axis=0)
        for p in self.profiles:
            if p.name == name:
                p.absorb(emb, 0.5)
                return p
        p = Profile("enroll:" + name.lower().replace(" ", "-"), name, emb, enrolled=True)
        self.profiles.append(p)
        return p

    def label(self, pid, name=None, speaker=None):
        """Tag a voice once: attach a display name and/or a party to a cluster. This is what
        turns an anonymous session cluster into a persistent profile."""
        for p in self.profiles:
            if p.pid == pid:
                if name is not None:
                    p.name = name or None
                if speaker is not None:
                    p.speaker = speaker or None
                return p
        return None

    def confirm(self, ts, speaker, name=None):
        """A user correction: the chunk at `ts` belongs to `speaker`. Train the matching party
        profile on that exact embedding (stronger than the passive EMA, still capped), creating
        the party profile from this chunk if none exists yet. Returns the profile or None."""
        emb = None
        for t, e, _cluster in self._recent:
            if t == ts:
                emb = e
                break
        if emb is None:
            return None
        target = None
        for p in self.profiles:
            if p.speaker == speaker and (target is None or (p.name and not target.name)):
                target = p
        if target is None:
            pid = "P%d" % self._next_cluster
            self._next_cluster += 1
            target = Profile(pid, name, emb, speaker=speaker)
            self.profiles.append(target)
        else:
            target.absorb(emb, min(0.25, self.ema * 2))
            if name and not target.name:
                target.name = name
        return target

    def remove(self, pid):
        before = len(self.profiles)
        self.profiles = [p for p in self.profiles if p.pid != pid]
        return len(self.profiles) < before

    # ----- persistence (named/party profiles only; see Profile.persistent) -----
    def save(self, path):
        data = dict(version=1, profiles=[p.to_dict() for p in self.profiles if p.persistent],
                    next_cluster=self._next_cluster)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)   # atomic: a crash mid-save never corrupts the store

    def load(self, path):
        try:
            with open(path) as f:
                data = json.load(f)
        except (FileNotFoundError, ValueError):
            return 0
        loaded = [Profile.from_dict(d) for d in data.get("profiles", [])]
        self.profiles = loaded + [p for p in self.profiles if not p.persistent]
        self._next_cluster = max(int(data.get("next_cluster", 1)), self._next_cluster)
        return len(loaded)

    # ----- the per-chunk decision -----
    def identify(self, samples, voiced_ms, sample_rate=16000, allow_spawn=True, train=True,
                 ts=None):
        """Return a verdict dict for one VAD chunk. Mirrors the sidecar /identify contract.
        When `ts` is given the embedding is remembered so a later /confirm can train on it."""
        emb = self.embed(samples, sample_rate)
        v = self._decide(emb, voiced_ms, allow_spawn, train)
        if ts is not None and v.get("cluster"):
            self._recent.append((ts, emb, v["cluster"]))
        return v

    def _decide(self, emb, voiced_ms, allow_spawn, train):
        if not self.profiles:
            return self._spawn_or_unknown(emb, voiced_ms, allow_spawn)

        sims = np.array([float(p.centroid @ emb) for p in self.profiles])
        order = np.argsort(-sims)
        best_i = int(order[0])
        best = float(sims[best_i])
        second = float(sims[int(order[1])]) if len(sims) > 1 else -1.0
        margin_pct = 100.0 * (best - second) / best if best > 0 else 0.0
        p = self.profiles[best_i]

        if best >= self.accept and (len(sims) == 1 or margin_pct >= self.min_margin_pct):
            if train and voiced_ms >= self.min_train_ms:
                self._trains += 1
                target = p
                if self.poison_every and self._trains % self.poison_every == 0 and len(sims) > 1:
                    target = self.profiles[int(order[1])]   # deliberate wrong confirmation
                target.absorb(emb, self.ema)
            decision = "accept"
        elif best >= self.suggest:
            decision = "suggest"
        else:
            return self._spawn_or_unknown(emb, voiced_ms, allow_spawn, best=best, margin_pct=margin_pct)

        return dict(decision=decision, cluster=p.pid, name=p.name, speaker=p.speaker,
                    sim=round(best, 4), margin_pct=round(margin_pct, 1))

    def _spawn_or_unknown(self, emb, voiced_ms, allow_spawn, best=None, margin_pct=None):
        # A voice unlike every profile: a NEW cluster if there is enough clean audio to trust
        # the embedding, otherwise an explicit unknown (never a guess).
        if allow_spawn and voiced_ms >= self.min_spawn_ms:
            pid = "V%d" % self._next_cluster
            self._next_cluster += 1
            self.profiles.append(Profile(pid, None, emb))
            return dict(decision="new", cluster=pid, name=None, speaker=None,
                        sim=best if best is None else round(best, 4),
                        margin_pct=margin_pct if margin_pct is None else round(margin_pct, 1))
        return dict(decision="unknown", cluster=None, name=None, speaker=None,
                    sim=best if best is None else round(best, 4),
                    margin_pct=margin_pct if margin_pct is None else round(margin_pct, 1))
