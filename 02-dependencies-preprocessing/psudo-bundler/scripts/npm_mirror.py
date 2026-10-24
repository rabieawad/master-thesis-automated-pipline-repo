import asyncio
import gzip
import json
import logging
import os
import shutil
import sys
import tarfile
from concurrent.futures import ProcessPoolExecutor
from io import BytesIO

import aiohttp


def write_tarball_to_disk(tarball, meta):
    # Only extract js files
    with tarfile.open(fileobj=tarball, mode="r:gz") as tf:
        for ti in tf.getmembers():
            ti: tarfile.TarInfo
            if ti.isfile() and (ti.name[-2:] == "js" or ti.name[-4:] == "json"):
                reldir = os.path.dirname(
                    ti.name[8:]
                )  # strip "package/"
                filename = ti.name.rsplit("/", 2)[-1]
                fulldir = f"{meta['name']}@{meta['version']}/{reldir}"
                os.makedirs(fulldir, exist_ok=True)

                with open(f"{fulldir}/{filename}", "wb") as f:
                    f.write(tf.extractfile(ti.name).read())


async def process_version(meta, semaphore: asyncio.Semaphore, executor):
    meta["name"] = meta["name"].replace("/", "+")
    directory = f"{meta['name']}@{meta['version']}"
    if os.path.exists(directory):
        # Package already exists
        return

    async with semaphore:
        url = meta["tarball"]
        print(meta)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url) as resp:
                    if resp.status >= 300:
                        logging.warning(f"Response code {resp.status}, skipping {url}")
                        return

                    tarball = BytesIO(await resp.read())
                    await asyncio.get_event_loop().run_in_executor(executor, write_tarball_to_disk, tarball, meta)

        except Exception as e:
            if os.path.exists(directory):
                shutil.rmtree(directory, ignore_errors=True)
            raise asyncio.CancelledError() from e


async def main(wd):
    with gzip.open(sys.argv[1], "r") as f:
        libs = json.load(f)

    os.chdir(wd)

    semaphore = asyncio.Semaphore(os.cpu_count() * 8)

    with ProcessPoolExecutor(max_workers=os.cpu_count() - 1) as executor:
        async with asyncio.TaskGroup() as tg:
            for versions in libs.values():
                for meta in versions:
                    tg.create_task(process_version(meta, semaphore, executor))


if __name__ == "__main__":
    workdir = os.getenv("NPM_DIR", "/npm/mirror")

    asyncio.run(main(workdir))
