import asyncio
import os
import sys
import time

import pipeline

QUEUE_NAME_IN = os.getenv("QUEUE_NAME_IN")
QUEUE_NAME_OUT = os.getenv("QUEUE_NAME_OUT")
MAX_PER_SECOND = int(os.getenv("MAX_PER_SECOND", "10"))
QUEUE_LENGTH_OUT = int(os.getenv("QUEUE_LENGTH_OUT", str(2 * MAX_PER_SECOND)))

global_time = time.time()
global_count = 0


async def throttle(msg):
    global global_time, global_count

    current_time = time.time()
    if current_time - global_time > 1:
        global_time = current_time
        global_count = 0

    global_count += 1
    if global_count > MAX_PER_SECOND:
        await asyncio.sleep(1 - (current_time - global_time))

    return msg


if __name__ == "__main__":
    if "AMQP_URI" not in os.environ:
        print("Missing environment variable 'AMQP_URI'", file=sys.stderr)
        exit(1)

    pipeline.run(
        pipeline.publisher_consumer(
            os.environ["AMQP_URI"],
            (QUEUE_NAME_IN, QUEUE_NAME_OUT),
            throttle,
            prefetch_count=1000,
            max_length=(10000, QUEUE_LENGTH_OUT if QUEUE_LENGTH_OUT > 0 else None),
        ),
    )
