# Fetch a SCOTUS oral argument from Oyez: the audio plus the speaker-identified, time-aligned
# transcript (our free ground truth, see SPEAKER-AUTO-ID-PLAN.md section 10.1). Usage:
#
#   python oyez_fetch.py --list --term 2025            # show that term's argued cases
#   python oyez_fetch.py --term 2025 --docket 24-123   # download audio + ground_truth.json
#
# Output layout: assets/<term>-<docket>/audio.mp3, audio-16k.wav (via ffmpeg), ground_truth.json
# with turns [{speaker, start, stop}] in seconds. Audio stays git-ignored.

import argparse, json, os, subprocess, sys, urllib.request

UA = {"User-Agent": "hearing-copilot-diarization-eval/0.1 (research use)"}


def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def list_term(term):
    # The list view omits oral_argument_audio; an "Argued" timeline event is the reliable flag.
    cases = get_json("https://api.oyez.org/cases?filter=term:%s&per_page=200" % term)
    for c in cases:
        argued = any(ev.get("event") == "Argued" for ev in c.get("timeline") or [])
        if argued:
            print("%-12s %s" % (c.get("docket_number"), c.get("name")))


def fetch(term, docket, outdir):
    case = get_json("https://api.oyez.org/cases/%s/%s" % (term, docket))
    if isinstance(case, list):
        case = case[0]
    audio_refs = case.get("oral_argument_audio") or []
    if not audio_refs:
        sys.exit("case has no oral argument audio")
    media = get_json(audio_refs[0]["href"])

    os.makedirs(outdir, exist_ok=True)

    # 1) ground truth: transcript sections -> turns with speaker + start/stop seconds
    turns = []
    transcript = media.get("transcript") or {}
    for section in transcript.get("sections") or []:
        for t in section.get("turns") or []:
            spk = (t.get("speaker") or {}).get("name") if t.get("speaker") else None
            start, stop = t.get("start"), t.get("stop")
            if spk and start is not None and stop is not None and stop > start:
                turns.append(dict(speaker=spk, start=float(start), stop=float(stop)))
    if not turns:
        sys.exit("no speaker-labeled turns found in transcript JSON")
    gt = dict(term=term, docket=docket, title=transcript.get("title") or case.get("name"),
              turns=turns)
    with open(os.path.join(outdir, "ground_truth.json"), "w") as f:
        json.dump(gt, f, indent=1)
    speakers = sorted({t["speaker"] for t in turns})
    print("ground truth: %d turns, %d speakers: %s" % (len(turns), len(speakers), ", ".join(speakers)))

    # 2) audio: prefer an mp3 media file
    url = None
    for mf in media.get("media_file") or []:
        href = (mf or {}).get("href") or ""
        if href.endswith(".mp3"):
            url = href
            break
        url = url or href
    if not url:
        sys.exit("no media_file href in case media JSON")
    mp3 = os.path.join(outdir, "audio.mp3")
    if not os.path.exists(mp3):
        print("downloading", url)
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=600) as r, open(mp3, "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
    wav = os.path.join(outdir, "audio-16k.wav")
    if not os.path.exists(wav):
        subprocess.check_call(["ffmpeg", "-loglevel", "error", "-y", "-i", mp3,
                               "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", wav])
    print("ready:", wav)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--term", required=True)
    ap.add_argument("--docket")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--outdir")
    a = ap.parse_args()
    if a.list:
        list_term(a.term)
    else:
        if not a.docket:
            sys.exit("--docket required (or use --list)")
        fetch(a.term, a.docket, a.outdir or os.path.join("assets", "%s-%s" % (a.term, a.docket)))
