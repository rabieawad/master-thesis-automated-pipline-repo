import asyncio
import json
import os
import pickle
import sys
import time

import aio_pika.exceptions
import aiohttp
import pipeline

QUEUE_NAME_IN = os.getenv("QUEUE_NAME_IN")
QUEUE_NAME_OUT = os.getenv("QUEUE_NAME_OUT")
QUEUE_LENGTH_IN = int(os.getenv("QUEUE_LENGTH_IN", "20"))
MAX_PARALLEL_COUNTER = int(os.getenv("MAX_PARALLEL_COUNTER", "2"))
PORT = int(os.getenv("PORT", "5444"))

i = 0


async def bundlefetcher_stealth(queue, publish):
    global i

    j = (i := i + 1)
    print(f"Starting bundlefetcher_stealth worker{j}", file=sys.stderr)
    try:
        while True:
            async with aiohttp.ClientSession() as client:
                restart = False
                while not restart:
                    try:
                        message = await queue.get()
                    except aio_pika.exceptions.QueueEmpty:
                        await asyncio.sleep(4)
                        continue

                    async with message.process(ignore_processed=True):
                        domain = pipeline.deserialize(message.body)
                        print(f"Processing domain {domain}", file=sys.stderr)

                        done = False
                        while not done:
                            try:
                                async with client.get(
                                    f"http://localhost:{PORT}/fetch", params={"url": f"https://{domain}"}
                                ) as resp:
                                    if resp.status == 429:
                                        await asyncio.sleep(0.2)
                                        continue
                                    done = True
                                    try:
                                        result = await resp.json()
                                        await publish(
                                            {"meta": {"domain": domain, "length": len(result)}, "data": result}
                                        )
                                        print(f"Finished processing domain {domain}", file=sys.stderr)
                                    except json.JSONDecodeError as e:
                                        print(f"JSONDecodeError for domain {domain}: {e}", file=sys.stderr)
                                        await publish({"meta": {"domain": domain, "error": str(e)}, "data": None})
                            except (aiohttp.ClientError, ConnectionRefusedError) as e:
                                print(f"Bundlefetcher {j}: Caught exception {e}", file=sys.stderr)
                                await asyncio.sleep(2)
                                done = True
                                restart = True
                                await message.reject(requeue=True)

    except KeyboardInterrupt:
        raise
    except Exception as e:
        print(f"Bundlefetcher {j}: Caught fatal exception {e}", file=sys.stderr)
        raise
    finally:
        print(f"Bundlefetcher {j} exiting...", file=sys.stderr)


if __name__ == "__main__":
    if "AMQP_URI" not in os.environ:
        print("Missing environment variable 'AMQP_URI'", file=sys.stderr)
        exit(1)

    # Startup delay for puppeteer to start
    time.sleep(3)

    pipeline.run(
        pipeline.publisher_consumer_with_worker(
            os.environ["AMQP_URI"],
            (QUEUE_NAME_IN, QUEUE_NAME_OUT),
            bundlefetcher_stealth,
            nworker=MAX_PARALLEL_COUNTER,
            prefetch_count=100,
            max_length=(QUEUE_LENGTH_IN if QUEUE_LENGTH_IN > 0 else None, None),
        ),
    )
