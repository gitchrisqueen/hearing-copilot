# Score a replay run against ground truth (SPEAKER-AUTO-ID-PLAN.md section 10.2). Reports the
# numbers the plan's pass criteria use: chunk attribution accuracy (count- and time-weighted),
# decision mix (accept/suggest/new/unknown), wrong-name rate among accepts, label flicker,
# time-to-stable per speaker, and a per-speaker confusion table. Chunks that end before the
# enrollment window closes (meta.enrolled_from) are excluded: the engine saw that audio.
#
#   python score.py --run results/run.jsonl --truth assets/X/ground_truth.json [--json out.json]
#
# Cold-start runs have anonymous clusters (V1..Vn); we map cluster -> speaker greedily by
# time-weighted overlap (an optimistic, DER-style mapping; noted in the output).

import argparse, collections, json


def load_run(path):
    meta, chunks = None, []
    for line in open(path):
        row = json.loads(line)
        if row.get("kind") == "meta":
            meta = row
        elif row.get("kind") == "chunk":
            chunks.append(row)
    return meta, chunks


def dominant_speaker(turns, start, end):
    """Ground-truth speaker with the most overlap inside [start, end], plus overlap seconds."""
    best, best_ov, total = None, 0.0, 0.0
    for t in turns:
        ov = min(end, t["stop"]) - max(start, t["start"])
        if ov > 0:
            total += ov
            if ov > best_ov:
                best, best_ov = t["speaker"], ov
    return best, best_ov, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--truth", required=True)
    ap.add_argument("--json")
    ap.add_argument("--stable-window", type=int, default=3,
                    help="consecutive correct chunks required to call a speaker's label stable")
    a = ap.parse_args()

    meta, chunks = load_run(a.run)
    truth = json.load(open(a.truth))
    turns = truth["turns"]
    t_start = (meta or {}).get("enrolled_from") or 0.0

    rows = []
    for c in chunks:
        if c["start"] < t_start:
            continue
        spk, ov, tot = dominant_speaker(turns, c["start"], c["end"])
        if spk is None:
            continue                      # no ground-truth speech under this chunk
        dur = c["end"] - c["start"]
        rows.append(dict(c, gt=spk, gt_overlap=ov, gt_total=tot, dur=dur,
                         mixed=(ov / tot) < 0.8 if tot else False))
    if not rows:
        raise SystemExit("no scorable chunks (check enrolled_from vs audio length)")

    named = any(r.get("name") for r in rows)
    if not named:
        # Cold start: greedy time-weighted cluster -> speaker mapping.
        weight = collections.Counter()
        for r in rows:
            if r.get("cluster"):
                weight[(r["cluster"], r["gt"])] += r["dur"]
        mapping, used_c, used_s = {}, set(), set()
        for (cl, sp), _w in weight.most_common():
            if cl in used_c or sp in used_s:
                continue
            mapping[cl] = sp
            used_c.add(cl)
            used_s.add(sp)
        for r in rows:
            r["name"] = mapping.get(r.get("cluster"))

    n = len(rows)
    T = sum(r["dur"] for r in rows)
    mix = collections.Counter(r["decision"] for r in rows)
    acc_rows = [r for r in rows if r["decision"] == "accept"]
    lab_rows = [r for r in rows if r["decision"] in ("accept", "suggest") and r.get("name")]

    def frac(rows_, key=lambda r: True, dur=False):
        sel = [r for r in rows_ if key(r)]
        if dur:
            return sum(r["dur"] for r in sel) / T if T else 0.0
        return len(sel) / n if n else 0.0

    def correct(r):
        return r["name"] == r["gt"]
    summary = dict(
        run=a.run, model=(meta or {}).get("model"), chunks=n, eval_hours=round(T / 3600, 2),
        thresholds=dict(accept=(meta or {}).get("accept"), suggest=(meta or {}).get("suggest"),
                        margin_pct=(meta or {}).get("margin_pct")),
        mapping="named" if named else "greedy-cold",
        decision_mix={k: round(v / n, 3) for k, v in sorted(mix.items())},
        accept_coverage=round(len(acc_rows) / n, 3),
        accept_accuracy=round(sum(map(correct, acc_rows)) / len(acc_rows), 3) if acc_rows else None,
        accept_accuracy_time=round(sum(r["dur"] for r in acc_rows if correct(r)) /
                                   sum(r["dur"] for r in acc_rows), 3) if acc_rows else None,
        wrong_name_rate=round(sum(1 for r in acc_rows if not correct(r)) / len(acc_rows), 4)
                        if acc_rows else None,
        labeled_accuracy=round(sum(map(correct, lab_rows)) / len(lab_rows), 3) if lab_rows else None,
        mixed_chunk_share=round(frac(rows, lambda r: r["mixed"]), 3),
    )

    # Cross-hearing metrics: how well ENROLLED speakers are named, and how often a NEW voice is
    # falsely given an enrolled name (the failure mode auto mode must not have).
    enrolled = set((meta or {}).get("enrolled") or [])
    if enrolled:
        er = [r for r in rows if r["gt"] in enrolled and r.get("name")
              and r["decision"] in ("accept", "suggest")]
        nr = [r for r in rows if r["gt"] not in enrolled]
        summary["enrolled_speaker_accuracy"] = \
            round(sum(1 for r in er if correct(r)) / len(er), 3) if er else None
        summary["new_speaker_false_name_rate"] = \
            round(sum(1 for r in nr if r.get("name") in enrolled and
                      r["decision"] in ("accept", "suggest")) / len(nr), 4) if nr else None

    # Flicker: same ground-truth speaker on consecutive labeled chunks, different assigned label.
    flips = 0
    prev_r = None
    for r in lab_rows:
        if prev_r and prev_r["gt"] == r["gt"] and prev_r["name"] != r["name"]:
            flips += 1
        prev_r = r
    minutes = T / 60 if T else 1
    summary["flicker_per_min"] = round(flips / minutes, 2)

    # Time-to-stable and per-speaker confusion.
    per = {}
    speech = collections.defaultdict(float)
    streak = collections.defaultdict(int)
    stable_at = {}
    for r in rows:
        g = r["gt"]
        d = per.setdefault(g, dict(chunks=0, correct=0, wrong=0, unlabeled=0, talk_s=0.0,
                                   confused_with=collections.Counter()))
        d["chunks"] += 1
        d["talk_s"] += r["dur"]
        speech[g] += r["dur"]
        if r.get("name") and r["decision"] in ("accept", "suggest"):
            if correct(r):
                d["correct"] += 1
                streak[g] += 1
                if g not in stable_at and streak[g] >= a.stable_window:
                    stable_at[g] = round(speech[g], 1)
            else:
                d["wrong"] += 1
                d["confused_with"][r["name"]] += 1
                streak[g] = 0
        else:
            d["unlabeled"] += 1
            streak[g] = 0
    for g, d in per.items():
        d["talk_s"] = round(d["talk_s"], 1)
        d["stable_after_s"] = stable_at.get(g)
        d["confused_with"] = dict(d["confused_with"].most_common(3))
    summary["per_speaker"] = per

    print(json.dumps({k: v for k, v in summary.items() if k != "per_speaker"}, indent=1))
    print("%-28s %6s %7s %6s %6s %9s %12s" %
          ("speaker", "chunks", "correct", "wrong", "unlab", "talk_s", "stable_at_s"))
    for g, d in sorted(per.items(), key=lambda kv: -kv[1]["talk_s"]):
        print("%-28s %6d %7d %6d %6d %9.0f %12s %s" %
              (g[:28], d["chunks"], d["correct"], d["wrong"], d["unlabeled"], d["talk_s"],
               str(d["stable_after_s"]), ("<- " + ", ".join(d["confused_with"])) if d["confused_with"] else ""))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(summary, f, indent=1)


if __name__ == "__main__":
    main()
