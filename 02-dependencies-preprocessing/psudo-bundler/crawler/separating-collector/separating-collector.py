import hashlib
import os
import pprint
import sys
import time
from datetime import datetime
from urllib.parse import quote_plus

import pipeline
import pymongo

store = None

QUEUE_NAME_IN = os.getenv("QUEUE_NAME_IN")
QUEUE_NAME_OUT = os.getenv("QUEUE_NAME_OUT")

def sha1(data):
    if isinstance(data, str):
        return hashlib.sha1(data.encode(), usedforsecurity=False).hexdigest()
    else:
        return hashlib.sha1(data, usedforsecurity=False).hexdigest()


async def separating_collector(msg):
    objects = []
    meta = []

    if isinstance(msg["data"], list):
        for entry in msg["data"]:
            if entry["type"] == "redirect":
                meta.append({
                    "type": "redirect",
                    "url": entry["url"],
                    "status": entry["status"],
                    "location": entry["location"],
                })

            elif entry["type"] == "js":
                obj = entry["body"]
                key = sha1(obj)
                objects.append((key, obj))

                key2 = None
                if "sourceMapData" in entry:
                    obj2 = entry["sourceMapData"]
                    key2 = sha1(obj2)
                    objects.append((key2, obj2))

                meta.append({
                    "type": "js",
                    "url": entry["url"],
                    "status": entry["status"],
                    "source": key,
                    "sourceMapUrl": entry.get("sourceMapUrl", None),
                    "sourceMap": key2,
                })

            else:
                print(f"ERROR: unexpected type {entry['type']}", file=sys.stderr)

    result = {
        "domain": msg["meta"]["domain"],
        "time": datetime.now(),
        "meta": meta,
    }

    try:
        store(result)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        pass
    finally:
        print(f"Task solved: {str(result)[:256]}")

    return objects


if __name__ == "__main__":
    if "AMQP_URI" not in os.environ:
        print("Missing environment variable 'AMQP_URI'", file=sys.stderr)
        exit(1)

    db_host = os.getenv("MONGOHOST", None)
    db_user = os.getenv("MONGOUSER", None)
    db_pass = os.getenv("MONGOPASS", None)
    db_name = os.getenv("MONGODB", "analysis")

    userpass = ""
    if db_user and db_pass:
        userpass = f"{quote_plus(db_user)}:{quote_plus(db_pass)}@"

    if db_host:
        db_client = pymongo.MongoClient(f"mongodb://{userpass}{db_host}")
        db = getattr(db_client, db_name)

        def get_collection():
            return getattr(db, time.strftime("results-%Y%m%d"))

        store = lambda doc: get_collection().insert_one(doc)

    else:
        store = lambda doc: pprint.pprint(doc)

    pipeline.run(
        pipeline.publisher_consumer(
            os.environ["AMQP_URI"],
            (QUEUE_NAME_IN, QUEUE_NAME_OUT),
            separating_collector,
            prefetch_count=1000,
        ),
    )
