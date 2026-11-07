"""Smoke test: asks each model for 'pong' and prints the first 80 chars or the error."""
import muse_clients as mc

MSG = [{"role": "user", "content": "Reply with the single word: pong"}]


def show(name, fn):
    try:
        print(f"{name}: {(fn() or '').strip()[:80]!r}", flush=True)
    except Exception as e:
        print(f"{name}: ERROR {str(e)[:200]}", flush=True)


if __name__ == "__main__":
    show("muse_wonder (low)", lambda: mc.muse_wonder(MSG, effort="low", max_tokens=2000))
    show("muse_spark", lambda: mc.muse_spark(MSG))
    show("muse_spark_baseten", lambda: mc.muse_spark_baseten(MSG))
    for judge, text in mc.council(MSG, max_tokens=2000).items():
        print(f"council/{judge}: {text.strip()[:80]!r}")
