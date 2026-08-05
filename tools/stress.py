#!/usr/bin/env python3
"""
Spark Live — soak test against a deployed site.

Drives the real /api/asr and /api/chat endpoints at the cadence the engine
actually uses, so the numbers mean something: the same 2.2 s confirm pass, the
same correct-and-translate call, the same payload shapes.

It spends real quota. At the default cadence one minute costs ~27 ASR requests
out of a 16,000/day pool (8 keys), i.e. about 0.17% per minute. The summary
reports exactly what it used.

  python3 tools/stress.py --minutes 5
  python3 tools/stress.py --minutes 60 --base https://your-site.netlify.app

What to look for:
  * p95 ASR latency climbing over time  -> keys are being throttled
  * any 429 at all                      -> the pool is at its limit
  * translate p95 > ~4 s                -> audience will feel the lag
"""
import argparse, json, os, statistics, sys, time, urllib.request, urllib.error, uuid

TICK_S = 2.2       # engine's confirm-pass cadence
UNIT_S = 6.0       # worst-case gap between translation units
WINDOW = "win_360.wav"

SYS = (
    "You are a professional live interpreter working in real time.\n"
    "Correct ASR errors only, then translate.\n"
    '   - "prs": Dari (Afghan Persian), Perso-Arabic script\n'
    '   - "en": English\n\n'
    'Reply with JSON only: {"corrected":"...","tr":{"prs":"...","en":"..."}}'
)
TEXT = "首先就是我們的視力，你看見我，我看見你，我們眼睛看得見有這個視力。"


def post(url, body, headers, timeout=90):
    t0 = time.time()
    req = urllib.request.Request(url, body, headers)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        r.read()
        return time.time() - t0, r.status, None
    except urllib.error.HTTPError as e:
        detail = e.read()[:120].decode("utf8", "replace")
        return time.time() - t0, e.code, detail
    except Exception as e:                       # network/timeout
        return time.time() - t0, 0, str(e)[:120]


def asr(base, wav):
    b = uuid.uuid4().hex
    body = (
        f'--{b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n'
        f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode() + wav + f"\r\n--{b}--\r\n".encode()
    return post(base + "/api/asr", body, {"Content-Type": f"multipart/form-data; boundary={b}"})


def chat(base):
    body = json.dumps({"sys": SYS, "prompt": TEXT, "model": "openai/gpt-oss-120b"}).encode()
    return post(base + "/api/chat", body, {"content-type": "application/json"})


def pct(xs, p):
    if not xs:
        return 0.0
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p / 100))]


def report(name, lat, codes, elapsed):
    ok = sum(1 for c in codes if c == 200)
    throttled = sum(1 for c in codes if c == 429)
    other = len(codes) - ok - throttled
    print(f"\n  {name}")
    print(f"    calls {len(codes):>5}   ok {ok:>5}   429 {throttled:>4}   other errors {other:>4}")
    if lat:
        print(f"    latency  p50 {pct(lat,50):.2f}s   p95 {pct(lat,95):.2f}s   max {max(lat):.2f}s")
    return ok, throttled, other


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://spark-live-translate.netlify.app")
    ap.add_argument("--minutes", type=float, default=5)
    ap.add_argument("--audio", default=WINDOW)
    args = ap.parse_args()

    if not os.path.exists(args.audio):
        sys.exit(f"need a 16 kHz mono WAV window at {args.audio}")
    wav = open(args.audio, "rb").read()

    total_s = args.minutes * 60
    print(f"soak: {args.minutes:g} min against {args.base}")
    print(f"  ~{int(total_s/TICK_S)} ASR + ~{int(total_s/UNIT_S)} translate calls "
          f"(~{int(total_s/TICK_S)/16000*100:.2f}% of an 8-key daily ASR pool)\n")

    start = time.time()
    a_lat, a_code, c_lat, c_code = [], [], [], []
    next_chat = start + UNIT_S
    first_fail = None

    while time.time() - start < total_s:
        cycle = time.time()
        dt, code, err = asr(args.base, wav)
        a_lat.append(dt); a_code.append(code)
        if code != 200 and first_fail is None:
            first_fail = (round(time.time() - start), "asr", code, err)

        if time.time() >= next_chat:
            dt, code, err = chat(args.base)
            c_lat.append(dt); c_code.append(code)
            if code != 200 and first_fail is None:
                first_fail = (round(time.time() - start), "chat", code, err)
            next_chat = time.time() + UNIT_S

        # keep the real cadence: the engine ticks every TICK_S regardless of
        # how long the previous pass took
        slack = TICK_S - (time.time() - cycle)
        if slack > 0:
            time.sleep(slack)

        done = time.time() - start
        if int(done) % 30 == 0 and done > 1:
            sys.stdout.write(f"\r  {int(done)}s  asr={len(a_code)} chat={len(c_code)} "
                             f"429={sum(1 for c in a_code+c_code if c==429)}   ")
            sys.stdout.flush()

    elapsed = time.time() - start
    print(f"\n\n─── {elapsed/60:.1f} min ───")
    ok_a, t_a, e_a = report("ASR  /api/asr", a_lat, a_code, elapsed)
    ok_c, t_c, e_c = report("chat /api/chat", c_lat, c_code, elapsed)

    print(f"\n  quota used: {len(a_code)} ASR ({len(a_code)/16000*100:.2f}% of daily), "
          f"{len(c_code)} chat ({len(c_code)/8000*100:.2f}% of daily)")
    if first_fail:
        print(f"  first failure at {first_fail[0]}s — {first_fail[1]} {first_fail[2]}: {first_fail[3]}")
    else:
        print("  no failures")

    healthy = (t_a + t_c) == 0 and (e_a + e_c) == 0
    print("\n  VERDICT:", "clean — pool kept up at full cadence" if healthy
          else "degraded — see 429/errors above")
    return 0 if healthy else 1


if __name__ == "__main__":
    sys.exit(main())
