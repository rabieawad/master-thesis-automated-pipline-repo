import argparse
import io
import lzma
import multiprocessing
import multiprocessing.shared_memory
import os
import subprocess
import sys
import tarfile
import time

import bson
import requests
from tqdm import tqdm

SHM_META_NAME = "aletheia_speed_eval_meta"
SHM_DATA_NAME = "aletheia_speed_eval"
WORKER = multiprocessing.cpu_count()
REQUIRES_SOURCE_MAP = False

CDN_HOSTS = [
    "//cdn.jsdelivr.net",
    "//cdnjs.cloudflare.com",
    "//unpkg.com",
    "//ajax.googleapis.com",
    "//ajax.aspnetcdn.com",
    "//code.jquery.com",
]

class DocumentV2:
    """
    Format used in daily scans.
    More polished and objects de-duplicated in object-storage.
    Source Maps always grouped.
    """
    def __init__(self, doc):
        self.version = 2
        self._doc = doc
        self._data = None
        self._read_cache = {}

    @property
    def domain(self):
        try:
            return self._doc["domain"]
        except KeyError:
            return "unknown"

    @property
    def has_error(self):
        return not isinstance(self.data, list)

    @property
    def data(self):
        return self._doc["meta"]

    @property
    def meta(self):
        return {
            "domain": self.domain,
            "time": self._doc["time"],
        }

    @staticmethod
    def get_type(data_element):
        return data_element["type"]


def build_job_list_from_single_file(file) -> set:
    jobs = set()

    with open(file, "rb") as f:
        for _doc in bson.decode_file_iter(f):
            assert "time" in _doc, f"Unsupported V1 document found in {file}"
            doc = DocumentV2(_doc)

            if not doc.has_error:
                for resp in doc.data:
                    if doc.get_type(resp) == "js":
                        skip_resp = False
                        for cdn in CDN_HOSTS:
                            if cdn in resp.get("url", ""):
                                skip_resp = True
                        if skip_resp:
                            continue

                        source = resp.get("source")
                        sourcemap = resp.get("sourceMap")

                        if REQUIRES_SOURCE_MAP and sourcemap is None:
                            continue

                        assert type(source) is str, f"Source has unexpected type {type(source)}"
                        resp_hash = f"{source}:{sourcemap if sourcemap is not None else ''}"
                        jobs.add(resp_hash)

    print(f"{len(jobs)} jobs found in {file}")
    return jobs


def build_job_list(files) -> set:
    jobs = set()

    with multiprocessing.Pool(WORKER) as pool:
        for jobset in pool.imap_unordered(build_job_list_from_single_file, files):
            jobs.update(jobset)

    return jobs


def worker(
        worker_id: int,
        next_job: multiprocessing.Value,
        total_jobs: int,
        output_file: str,
        output_lock: multiprocessing.Lock,
        index: dict,
):
    shm_meta = multiprocessing.shared_memory.SharedMemory(create=False, name=SHM_META_NAME)
    shm_data = multiprocessing.shared_memory.SharedMemory(create=False, name=SHM_DATA_NAME)

    PORT = int(os.getenv("PORT", "6666")) + int(worker_id)

    server = None

    def start_server():
        srv = subprocess.Popen(["node", "identification/identify.mjs"], env={**os.environ, "PORT": str(PORT)})
        time.sleep(1)

        # Wait for server to start
        for _ in range(1000):
            try:
                requests.get(f"http://localhost:{PORT}/alive", timeout=1)
                break
            except (ConnectionRefusedError, requests.Timeout, requests.ConnectionError):
                time.sleep(0.5)
        return srv

    try:
        server = start_server()
        print(f"Worker {worker_id}: Server started", file=sys.stderr)

        # noinspection PyTypeChecker
        jobs = [j.decode("ascii") for j in bytes(shm_meta.buf).split(b"\x00", total_jobs)][:total_jobs]
        while True:
            with next_job.get_lock():
                job_index = next_job.value
                if job_index >= total_jobs:
                    print(f"Worker {worker_id}: Finished", file=sys.stderr)
                    break
                next_job.value += 1

            # Work on job
            job = jobs[job_index]
            source_hash, sourcemap_hash = job.split(":")

            assert source_hash in index, f"source_hash not in object storage"

            try:
                offset, size = index[source_hash]
                # noinspection PyTypeChecker
                source = lzma.decompress(shm_data.buf[offset:offset + size]).decode()

                if len(sourcemap_hash) == 0:
                    sourcemap = None
                else:
                    assert sourcemap_hash in index, f" {sourcemap_hash=} not in object storage"
                    offset, size = index[sourcemap_hash]
                    # noinspection PyTypeChecker
                    sourcemap = lzma.decompress(shm_data.buf[offset:offset + size]).decode()

                try:
                    resp = requests.post(f"http://localhost:{PORT}/identify/without_truths/compartments", json={"source": source, "map": sourcemap})
                    if resp.status_code >= 300:
                        if resp.status_code == 501:
                            # Tried to parse JSON => ignore
                            pass
                        else:
                            print(f"Worker {worker_id}: Error for {job}", file=sys.stderr)

                        result = {
                            "id": job,
                            "error": resp.text
                        }
                    else:
                        result = resp.json()
                        result["id"] = job

                    # Store output
                    with output_lock:
                        with open(output_file, "ab") as f:
                            f.write(bson.encode(result))
                except (requests.RequestException,):
                    if server.poll() is not None:
                        server = start_server()

            except (lzma.LZMAError, UnicodeDecodeError) as e:
                print(f"Worker {worker_id}: Unexpected {type(e)} for {job}", file=sys.stderr)

    finally:
        try:
            server.terminate()
            server.wait(1)
        except (subprocess.TimeoutExpired, OSError):
            pass


def main():
    global WORKER, REQUIRES_SOURCE_MAP

    shm_meta = None
    shm_data = None

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        required=True,
        help=f"Output file in BSON format. May already contain partial data"
    )
    parser.add_argument(
        "-s",
        "--object-storage",
        type=str,
        required=True,
        help=f"tar of the object storage",
    )
    parser.add_argument(
        "files",
        type=str,
        nargs="+",
        help="Dataset files in bson format",
    )
    parser.add_argument(
        "--worker",
        type=int,
        help=f"Amount of subprocesses used. Default: {WORKER}",
    )
    parser.add_argument(
        "--requires-sourcemap",
        dest="requires_sourcemap",
        action="store_true",
        help=f"Require sourcemap to be available. Default: {REQUIRES_SOURCE_MAP}",
    )
    args = parser.parse_args()

    OUTPUT = args.output

    if args.worker:
        WORKER = args.worker

    if args.requires_sourcemap:
        REQUIRES_SOURCE_MAP = True

    try:

        # Step 1: Build job list
        print(f"Building job list from {len(args.files)} files", flush=True)
        jobs = build_job_list(args.files)

        # Step 0: Load storage into mem
        FILESIZE = os.stat(args.object_storage).st_size
        shm_data = multiprocessing.shared_memory.SharedMemory(create=True, size=FILESIZE, name=SHM_DATA_NAME)

        print(f"Reading {args.object_storage=} into RAM (this may take a while) ... ", flush=True)
        bs = 1024 * 1024
        with open(args.object_storage, mode="rb") as f:
            for offset in tqdm(range(0, FILESIZE, bs), unit="MByte", miniters=1500):
                shm_data.buf[offset : offset + bs] = f.read(bs)

        print(f"Building tar index (this may take a while) ... ", flush=True)
        index = {}
        # noinspection PyTypeChecker
        with tarfile.open(fileobj=io.BytesIO(shm_data.buf), mode="r|") as tf:
            while (member := tf.next()) is not None:
                index[member.name.rsplit("/", 1)[-1]] = (member.offset_data, member.size)

        # Step 2: Read output file and remove existing
        print(f"Found {len(jobs)} jobs", flush=True)
        try:
            with open(args.output, "rb") as f:
                for result in bson.decode_file_iter(f):
                    if result["id"] in jobs:
                        jobs.remove(result["id"])
            print(f"{len(jobs)} jobs remaining after cleanup")
        except FileNotFoundError:
            pass

        # Step 1: Create multiprocessing data
        next_job = multiprocessing.Value("i", 0)
        output_lock = multiprocessing.Lock()
        shm_len = sum(len(job)+1 for job in jobs)

        shm_meta = multiprocessing.shared_memory.SharedMemory(create=True, size=shm_len, name=SHM_META_NAME)
        print(f"Allocated {shm_len >> 10} KiB of shared memory for metadata")
        offset = 0
        for job in jobs:
            shm_meta.buf[offset:offset + len(job) + 1] = job.encode("ascii") + b"\x00"
            offset += len(job) + 1

        # Step 4: Create worker
        processes = []
        for i in range(WORKER):
            processes.append(multiprocessing.Process(target=worker, args=(i, next_job, len(jobs), OUTPUT, output_lock, index)))

        for process in processes:
            process.start()

        progress = tqdm(total=len(jobs), unit="jobs")
        while next_job.value < len(jobs) and not all(not p.is_alive() for p in processes):
            progress.n = next_job.value
            progress.update(0)
            time.sleep(1)
        progress.close()

        print("Collecting processes ...")
        for process in processes:
            process.join()

    finally:
        if shm_data:
            shm_data.close()
            shm_data.unlink()
        if shm_meta:
            shm_meta.close()
            shm_meta.unlink()

if __name__ == '__main__':
    main()
