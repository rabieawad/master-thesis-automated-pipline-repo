import argparse
import json
import multiprocessing
import multiprocessing.shared_memory
import os

import bson

WORKER = multiprocessing.cpu_count()

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

                        assert type(source) is str, f"Source has unexpected type {type(source)}"
                        resp_hash = f"{source}:{sourcemap if sourcemap is not None else ''}"
                        jobs.add((doc.domain, resp_hash))

    print(f"{len(jobs)} jobs found in {file}")
    return jobs


def worker(results, joblist):
    restored = []
    for domain, job in joblist:
        if job in results:
            restored.append(dict(domain=domain, **results[job]))
    return restored



def main():
    global WORKER

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        required=True,
        help=f"Output file in JSON format"
    )
    parser.add_argument(
        "-r",
        "--results",
        type=str,
        required=True,
        help=f"Results file in BSON format"
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
        "--restore-order",
        action="store_true",
        help=f"Restore dataset order",
    )
    args = parser.parse_args()

    if args.worker:
        WORKER = args.worker

    # Step 1: Build job list
    print(f"Building job list from {len(args.files)} files", flush=True)
    with multiprocessing.Pool(WORKER) as pool:
        jobs = pool.map(build_job_list_from_single_file, sorted(args.files))

    if not args.restore_order:
        jobsset = set()
        for joblist in jobs:
            jobsset.update(joblist)
        jobs = jobsset
        print("Length after deduplication:", len(jobs))

    # Step 2: Read results
    print("Reading results", flush=True)
    with open(args.results, "rb") as f:
        results = {r["id"]: r for r in bson.decode_all(f.read())}

    # Step 3: Recovering
    print("Recovering results", flush=True)
    if args.restore_order:
        with multiprocessing.Pool(WORKER) as pool:
            recovered = pool.starmap(worker, ((results, joblist) for joblist in jobs))
    else:
        recovered = worker(results, jobs)

    # Step 4: Write results
    print("Writing results", flush=True)
    with open(args.output, "w") as f:
        json.dump(recovered, f)

if __name__ == '__main__':
    main()
