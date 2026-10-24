import asyncio
import lzma
import os
import sys

import pipeline

QUEUE_NAME = os.getenv("QUEUE_NAME")
STORE = os.getenv("STORE", "/store")

hits = 0
misses = 0


async def object_storage(msg):
    global hits, misses

    for key, obj in msg:
        if not os.path.exists(f"{STORE}/{key}"):
            # No async functions available :(
            misses += 1
            if isinstance(obj, str):
                obj = obj.encode()
            compressed = lzma.compress(obj)
            await asyncio.sleep(0)  # At least one breakpoint if the data gets really large
            with open(f"{STORE}/{key}", "wb") as f:
                f.write(compressed)
        else:
            hits += 1

        # Pseudo-random print stats for 1/16th of objects
        if key[0] == "0":
            print(f"HITS {hits} / MISSES {misses}", file=sys.stderr)


if __name__ == "__main__":
    if "AMQP_URI" not in os.environ:
        print("Missing environment variable 'AMQP_URI'", file=sys.stderr)
        exit(1)

    pipeline.run(
        pipeline.consumer(
            os.environ["AMQP_URI"],
            QUEUE_NAME,
            object_storage,
        ),
    )
