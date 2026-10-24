import gzip
import json
import logging
import os.path
import re
import sys
import time

import requests

PLAIN_VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+)*$")
PROXY = None

cache = {}

def fetch_pkg(pkgname, libs, retry=0):
    libs[pkgname] = []

    # Fetch from npm as cdnjs version do not always match npm versions
    try:
        if pkgname not in cache:
            resp = requests.get(f"https://registry.npmjs.com/{pkgname}", proxies=PROXY)
            if resp.status_code >= 400:
                cache[pkgname] = None
                logging.warning(f"Could not fetch package {pkgname}")
                return
            else:
                cache[pkgname] = resp.json()
    except requests.RequestException as e:
        if retry < 10:
            logging.warning(f"Connection error, waiting a bit before retrying", exc_info=e)
            time.sleep(30)
            return fetch_pkg(pkgname, libs, retry=retry + 1)
        raise e

    if cache[pkgname] is None:
        return

    if "versions" not in cache[pkgname]:
        logging.debug(f"{cache[pkgname]}")
        logging.warning(f"'versions' not in npm response. Skipping...")
        return

    for version, data in cache[pkgname]["versions"].items():
        if PLAIN_VERSION_RE.match(version) is None:
            logging.info(f"Skipping special version {version}")
            continue

        libtype = "mjs" if "type" in data and data["type"] == "module" else "cjs"
        libs[pkgname].append(
            {
                "version": version,
                "type": libtype,
                "name": data.get("name"),
                "tarball": data.get("dist", {}).get("tarball"),
            }
        )
    logging.info(f"Fetched package {pkgname}")
    time.sleep(0.2)  # Naive rate limit

def fetch_versions():
    print("Loading package list... ", end="")
    with open(sys.argv[1], "r") as f:
        pkgs = json.load(f)
    print(f"DONE ({len(pkgs)} entries)")

    libs = {}

    print("Fetching versions... ", end="")
    for pkgname in pkgs:
        fetch_pkg(pkgname, libs)

    print(f"DONE ({sum([len(v) for v in libs.values()])} versions)")

    with gzip.open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "npm-versions.json.gz"), "wb") as f:
        f.write(json.dumps(libs).encode())


if __name__ == "__main__":
    fetch_versions()
