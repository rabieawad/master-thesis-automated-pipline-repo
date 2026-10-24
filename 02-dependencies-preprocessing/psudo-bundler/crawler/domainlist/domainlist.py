import asyncio
import csv
import datetime
import os
import random
import sys

import pipeline

QUEUE_NAME = os.getenv("QUEUE_NAME")
DAILY = bool(int(os.getenv("DAILY", "0")))


async def domainlist():
    print("Starting domainlist...", file=sys.stderr)

    while True:
        domains = []
        with open("domainlist.csv", "r") as f:
            reader = csv.reader(f)
            for row in reader:
                domains.append(row[1])

        random.shuffle(domains)
        i = 0
        for d in domains:
            yield d
            print(f"Queued domain {(i:=i+1)}/{len(domains)} {d}", file=sys.stderr)

        if DAILY:
            tomorrow = datetime.datetime.now() + datetime.timedelta(days=1)
            scheduled_in = (tomorrow.replace(hour=0, minute=15, second=0, microsecond=0) - datetime.datetime.now())
            print(f"Sleeping for {scheduled_in} until next run", file=sys.stderr)
            await asyncio.sleep(scheduled_in.total_seconds())
        else:
            # Only repeat for daily
            break

    print("Stopping domainlist...", file=sys.stderr)


if __name__ == "__main__":
    if "AMQP_URI" not in os.environ:
        print("Missing environment variable 'AMQP_URI'", file=sys.stderr)
        exit(1)

    pipeline.run(
        pipeline.async_publisher(os.environ["AMQP_URI"], QUEUE_NAME, domainlist, prefetch_count=1000, max_length=10000),
    )
