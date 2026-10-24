import argparse
import concurrent.futures
import gzip
import hashlib
import itertools
import json
import lzma
import multiprocessing
import multiprocessing.shared_memory
import os
import subprocess
import sys
import time

import bson
import requests
from tqdm import tqdm

SHM_NAME = "bundle-dataset-analyzer"
FILESIZE = 0

TOTAL = 1000000
WORKER = 90
STEPSIZE = TOTAL // WORKER + 1

BATCH_PER_FILE = False
BATCH_PER_DOMAIN = True
STORE = os.getenv("HOME") + "/data/object-storage"
REQUEST_CACHE = os.getenv("HOME") + "/data/request-cache"

HEADERS = None


class Document:
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

    def _get_file_prop(self, data_element, prop):
        if prop not in data_element or data_element[prop] is None:
            return None

        if f"{STORE}/{data_element[prop]}" in self._read_cache:
            return self._read_cache[f"{STORE}/{data_element[prop]}"]

        try:
            with open(f"{STORE}/{data_element[prop]}", "rb") as f:
                self._read_cache[f"{STORE}/{data_element[prop]}"] = lzma.decompress(f.read())
                return self._read_cache[f"{STORE}/{data_element[prop]}"]
        except (OSError, lzma.LZMAError):
            return None

    def get_source(self, data_element):
        return self._get_file_prop(data_element, "source")

    def get_source_map(self, data_element):
        return self._get_file_prop(data_element, "sourceMap")


CommonErrors = (json.JSONDecodeError, lzma.LZMAError, KeyError, AttributeError)


def get_urls(start_index, worker_id=None):
    shm = multiprocessing.shared_memory.SharedMemory(create=False, name=SHM_NAME)

    urls = []
    for i, _doc in enumerate(bson.decode_iter(shm.buf[:FILESIZE])):
        if start_index <= i < start_index + STEPSIZE:
            batch = []
            doc = Document(_doc)
            try:
                if not doc.has_error:
                    for obj in doc.data:
                        if "url" in obj:
                            batch.append(obj["url"])
                    if BATCH_PER_DOMAIN:
                        urls.append({"domain": doc.domain, "urls": batch})
                    else:
                        urls.extend(batch)
            except CommonErrors as e:
                print(f"Error for {doc.domain=}: {type(e)} {e}", file=sys.stderr)
            finally:
                with globals()["counter"].get_lock():
                    globals()["counter"].value += 1
    return urls


def count_responsive_sites(start_index, worker_id=None):
    shm = multiprocessing.shared_memory.SharedMemory(create=False, name=SHM_NAME)

    results = []
    for i, _doc in enumerate(bson.decode_iter(shm.buf[:FILESIZE])):
        if start_index <= i < start_index + STEPSIZE:
            doc = Document(_doc)
            try:
                if not doc.has_error:
                    if len([o for o in doc.data if doc.get_type(o) == "js"]) > 0:
                        results.append(True)
            except CommonErrors as e:
                print(f"Error for {doc.domain=}: {type(e)} {e}", file=sys.stderr)
            finally:
                with globals()["counter"].get_lock():
                    globals()["counter"].value += 1
    return len(results)


def extract_domain_artifacts(start_index, worker_id=None, searched_domain=None):
    shm = multiprocessing.shared_memory.SharedMemory(create=False, name=SHM_NAME)

    content = []
    for i, _doc in enumerate(bson.decode_iter(shm.buf[:FILESIZE])):
        if start_index <= i < start_index + STEPSIZE:
            doc = Document(_doc)
            try:
                if doc.domain == searched_domain:
                    content.append(
                        {
                            "meta": doc.meta,
                            "data": doc.data,
                        }
                    )
            except CommonErrors as e:
                print(f"Error for {doc.domain=}: {type(e)} {e}", file=sys.stderr)
            finally:
                with globals()["counter"].get_lock():
                    globals()["counter"].value += 1
    return content


def get_source_map_sources(start_index, worker_id=None):
    shm = multiprocessing.shared_memory.SharedMemory(create=False, name=SHM_NAME)

    sources = []
    for i, _doc in enumerate(bson.decode_iter(shm.buf[:FILESIZE])):
        if start_index <= i < start_index + STEPSIZE:
            batch = []
            doc = Document(_doc)
            try:
                if not doc.has_error:
                    for obj in doc.data:
                        try:
                            if doc.get_source_map(obj) is not None and len(doc.get_source_map(obj)) > 0:
                                source_map = json.loads(doc.get_source_map(obj))
                                batch.extend(source_map["sources"])
                            elif doc.version == 1 and doc.is_source_map(obj):
                                source_map = json.loads(obj["body"])
                                batch.extend(source_map["sources"])
                        except CommonErrors as e:
                            if len(doc.get_source_map(obj)) == 0:
                                print(f"Error for {doc.domain=} {obj=}: {type(e)} {e}", file=sys.stderr)
                            else:
                                print(
                                    f"Error for {doc.domain=} {obj['url']=} {len(doc.get_source_map(obj))[:32]=}: {type(e)} {e}",
                                    file=sys.stderr,
                                )
                    getattr(sources, "append" if BATCH_PER_DOMAIN else "extend")(batch)
            except CommonErrors as e:
                print(f"Error for {doc.domain=}: {type(e)} {e}", file=sys.stderr)
            finally:
                with globals()["counter"].get_lock():
                    globals()["counter"].value += 1
    return sources


def list_libraries(start_index, worker_id=None):
    shm = multiprocessing.shared_memory.SharedMemory(create=False, name=SHM_NAME)

    sources = set()
    for i, _doc in enumerate(bson.decode_iter(shm.buf[:FILESIZE])):
        if start_index <= i < start_index + STEPSIZE:
            doc = Document(_doc)
            try:
                if not doc.has_error:
                    for obj in doc.data:
                        try:
                            if doc.get_source_map(obj) is not None and len(doc.get_source_map(obj)) > 0 \
                                    or doc.version == 1 and doc.is_source_map(obj):
                                source_map = json.loads(doc.get_source_map(obj)) if doc.get_source_map(obj) is not None else json.loads(obj["body"])
                                if isinstance(source_map, dict) and "sources" in source_map and isinstance(source_map["sources"], list):
                                    for source in source_map["sources"]:
                                        if isinstance(source, str) and "node_modules/" in source:
                                            last_part = source.rsplit("node_modules/", 1)[-1]
                                            if len(last_part) > 0 and last_part[0] == "@":
                                                sources.add("/".join(last_part.split("/", 2)[:2]))
                                            else:
                                                sources.add(last_part.split("/", 1)[0])
                        except CommonErrors as e:
                            if len(doc.get_source_map(obj)) == 0:
                                print(f"Error for {doc.domain=} {obj=}: {type(e)} {e}", file=sys.stderr)
                            else:
                                print(
                                    f"Error for {doc.domain=} {obj['url']=} {doc.get_source_map(obj)[:32]=}: {type(e)} {e}",
                                    file=sys.stderr,
                                )

            except CommonErrors as e:
                print(f"Error for {doc.domain=}: {type(e)} {e}", file=sys.stderr)
            finally:
                with globals()["counter"].get_lock():
                    globals()["counter"].value += 1
    return list(sources)


def filter_source_map_sources(start_index, worker_id=None, f=".pnpm"):
    shm = multiprocessing.shared_memory.SharedMemory(create=False, name=SHM_NAME)

    sources = []
    for i, _doc in enumerate(bson.decode_iter(shm.buf[:FILESIZE])):
        if start_index <= i < start_index + STEPSIZE:
            doc = Document(_doc)
            batch = []
            try:
                if not doc.has_error:
                    for obj in doc.data:
                        try:
                            if doc.get_source_map(obj) is not None and len(doc.get_source_map(obj)) > 0 \
                                    or doc.version == 1 and doc.is_source_map(obj):
                                source_map = json.loads(doc.get_source_map(obj)) if doc.get_source_map(obj) is not None else json.loads(obj["body"])
                                if (isinstance(source_map, dict) and
                                        "sources" in source_map and
                                        isinstance(source_map["sources"], list)):
                                    batch.extend([s for s in source_map["sources"] if isinstance(s, str) and f in s])
                        except CommonErrors as e:
                            if len(doc.get_source_map(obj)) == 0:
                                print(f"Error for {doc.domain=} {obj=}: {type(e)} {e}", file=sys.stderr)
                            elif doc.get_source_map(obj)[:10].lstrip().lower() == "<!doctype ":
                                # Some hosts return HTML 404 pages with 200 OK status code, so ignore the error
                                pass
                            else:
                                print(
                                    f"Error for {doc.domain=} {obj['url']=} {doc.get_source_map(obj)[:32]=}: {type(e)} {e}",
                                    file=sys.stderr,
                                )
                if len(batch) > 0:
                    if BATCH_PER_DOMAIN:
                        sources.append({doc.domain: batch})
                    else:
                        sources.extend(batch)


            except CommonErrors as e:
                print(f"Error for {doc.domain=}: {type(e)} {e}", file=sys.stderr)
            finally:
                with globals()["counter"].get_lock():
                    globals()["counter"].value += 1
    return sources


def group_source_and_map(doc: Document):
    """
    Match JS source files with their source maps (if available)

    :raises KeyError If data does not have expected entries
    :param data: Entry from the dataset in the database
    :param only_with_source_map: Results only contain programs with matching source maps, otherwise contain all scripts
    :return: mapping_by_url, searching_for_source_file
    """
    mapping_by_url = {}  # "url" => [filebody, sourcemapbody]
    searching_for_source_map = {}
    searching_for_source_file = {}
    if not doc.has_error:
        if doc.version == 1:
            for obj in doc.data:
                if "sourceMapData" in obj and len(obj["sourceMapData"]) > 0:
                    mapping_by_url[obj["url"]] = [obj["body"], obj["sourceMapData"]]
                elif "sourceMapUrl" in obj and len(obj["sourceMapUrl"]) > 0:
                    mapping_by_url[obj["url"]] = [obj["body"], None]
                    if obj["url"] in searching_for_source_file:
                        mapping_by_url[obj["url"]][1] = searching_for_source_file[obj["url"]]
                        del searching_for_source_file[obj["url"]]
                    else:
                        searching_for_source_map[obj["sourceMapUrl"]] = obj["url"]
                else:
                    # We treat all others as source maps as we cannot assume that source maps will *always* end on .map
                    # This works, since if the files are no source maps, then they will just be ignored
                    #
                    # However, to have a meaningful warning message we use the following heuristic:
                    # - url must already be searched for OR
                    # - url must include ".map" OR
                    # - body must start with "{"
                    if obj["url"] in searching_for_source_map or ".map" in obj["url"] or obj["body"][:1] == "{":
                        if obj["url"] in searching_for_source_map:
                            mapping_by_url[searching_for_source_map[obj["url"]]][1] = obj["body"]
                            del searching_for_source_map[obj["url"]]
                        else:
                            searching_for_source_file[obj["url"]] = obj["body"]
        elif doc.version == 2:
            mapping_by_url = { obj["url"]: [
                doc.get_source(obj).decode() if doc.get_source(obj) is not None else None,
                doc.get_source_map(obj).decode() if doc.get_source_map(obj) is not None else None,
            ] for obj in doc.data
              if doc.get_type(obj) == "js" and
                 doc.get_source(obj) is not None
            }

    return mapping_by_url, searching_for_source_file


def identify_scaffold(
        start_index,
        worker_id=None,
        endpoint="/",
        requires_sourcemap=True,
        appender=lambda l, r, **kwargs: l.append(r),
        cache=False,
):
    shm = multiprocessing.shared_memory.SharedMemory(create=False, name=SHM_NAME)

    PORT = int(os.getenv("PORT", "42000")) + int(worker_id)
    env = {**os.environ, "PORT": str(PORT)}

    server = subprocess.Popen(["node", "identification/identify.mjs"], env=env)
    time.sleep(1)

    print(f"Worker {worker_id}: Waiting for server start", file=sys.stderr)
    # Wait for server to start
    for _ in range(1000):
        try:
            requests.get(f"http://localhost:{PORT}/alive", timeout=0.1)
            break
        except (ConnectionRefusedError, requests.Timeout):
            time.sleep(0.1)
    print(f"Worker {worker_id}: Server started", file=sys.stderr)

    identification_results = []

    try:
        for i, _doc in enumerate(bson.decode_iter(shm.buf[:FILESIZE])):
            if start_index <= i < start_index + STEPSIZE:
                doc = Document(_doc)
                batch = []
                try:
                    mapping_by_url, searching_for_source_file = {}, {}

                    try:
                        mapping_by_url, searching_for_source_file = group_source_and_map(doc)
                    except KeyError as e:
                        print(f"Error for {doc.domain=}: {type(e)} {e}", file=sys.stderr)

                    if doc.version == 1:
                        open_searches = list(filter(lambda s: "json" not in s, searching_for_source_file))
                        if len(open_searches) > 0:
                            print(
                                f"Worker {worker_id} Warning: The following maps are missing a source file ({doc.domain=}): \n"
                                f"    {'\n    '.join(open_searches)}",
                                file=sys.stderr,
                            )

                    for url, script_and_map in mapping_by_url.items():
                        script, sourcemap = script_and_map
                        if requires_sourcemap and sourcemap is None:
                            continue

                        if cache:
                            request_hash = hashlib.sha1(json.dumps({"endpoint": endpoint, "headers": HEADERS, "source": script, "map": sourcemap}).encode(), usedforsecurity=False).hexdigest()

                        if cache and os.path.exists(f"{REQUEST_CACHE}/{request_hash}"):
                            with gzip.open(f"{REQUEST_CACHE}/{request_hash}", "rb") as f:
                                result = json.load(f)
                                appender(batch, result, domain=doc.domain, url=url, sourcemap=sourcemap)
                        else:
                            resp = requests.post(
                                f"http://localhost:{PORT}{endpoint}",
                                json={
                                    "source": script,
                                    "map": sourcemap,
                                },
                                headers=HEADERS,
                            )
                            if resp.status_code >= 300:
                                if resp.status_code == 501:
                                    # Tried to parse JSON => ignore
                                    pass
                                else:
                                    print(
                                        f"Error for {doc.domain=} ({url=}): {resp.status_code} {resp.text}", file=sys.stderr
                                    )
                            else:
                                result = resp.json()
                                appender(batch, result, domain=doc.domain, url=url, sourcemap=sourcemap)
                                if cache:
                                    data = json.dumps(result).encode()
                                    if len(data) > 1024:
                                        # only cache non-trivial responses
                                        with gzip.open(f"{REQUEST_CACHE}/{request_hash}", "wb") as f:
                                            f.write(data)

                except CommonErrors as e:
                    import traceback
                    print(f"Error for {doc.domain=}: {type(e)} {e} {traceback.format_tb(e.__traceback__)}", file=sys.stderr)
                finally:
                    identification_results.append(batch)
                    with globals()["counter"].get_lock():
                        globals()["counter"].value += 1

    finally:
        try:
            server.terminate()
            server.wait(1)
        except (subprocess.TimeoutExpired, OSError):
            pass

    return identification_results


def identify_bundler(start_index, worker_id=None):
    def appender(identification_results, result, **kwargs):
        domain = kwargs["domain"] if "domain" in kwargs else "unknown"
        url = kwargs["url"] if "url" in kwargs else "unknown"
        identification_results.append({"domain": domain, "url": url, "bundlers": result})

    return identify_scaffold(start_index, worker_id, endpoint="/identify/bundler", appender=appender, requires_sourcemap=False)


def version_detection(start_index, worker_id=None):
    def appender(identification_results, result, **kwargs):
        domain = kwargs["domain"] if "domain" in kwargs else "unknown"
        url = kwargs["url"] if "url" in kwargs else "unknown"
        if "dependencies" in result:
            del result["dependencies"]
        if "similarities" in result and len(result["similarities"]) > 0:
            identification_results.append({"domain": domain, "url": url, "libraries": result})

    return identify_scaffold(start_index, worker_id, endpoint="/identify/versions/no_compartments", appender=appender, cache=True)


def version_detection_with_compartments(start_index, worker_id=None):
    def appender(identification_results, result, **kwargs):
        domain = kwargs["domain"] if "domain" in kwargs else "unknown"
        url = kwargs["url"] if "url" in kwargs else "unknown"
        if "dependencies" in result:
            del result["dependencies"]
        if "modules" in result and len(result["modules"]) > 0:
            identification_results.append({"domain": domain, "url": url, "libraries": result})

    return identify_scaffold(start_index, worker_id, endpoint="/identify/versions/compartments", appender=appender, cache=True)


def library_string_identification(start_index, worker_id=None):
    def appender(identification_results, result, **kwargs):
        domain = kwargs["domain"] if "domain" in kwargs else "unknown"
        url = kwargs["url"] if "url" in kwargs else "unknown"
        if "matchedFingerprints" in result and len(result["matchedFingerprints"]) > 0:
            identification_results.append({"domain": domain, "url": url, "libraries": result})

    return identify_scaffold(start_index, worker_id, endpoint="/identify/libraries/strings", appender=appender)


def bundler_compartment_identification(start_index, worker_id=None):
    def appender(identification_results, result, **kwargs):
        domain = kwargs["domain"] if "domain" in kwargs else "unknown"
        url = kwargs["url"] if "url" in kwargs else "unknown"
        if "bundlers" in result:
            identification_results.append({"domain": domain, "url": url, "identification": result})

    return identify_scaffold(start_index, worker_id, endpoint="/identify/bundler-compartments", appender=appender)


def library_string_identification_with_compartments(start_index, worker_id=None):
    def appender(identification_results, result, **kwargs):
        domain = kwargs["domain"] if "domain" in kwargs else "unknown"
        url = kwargs["url"] if "url" in kwargs else "unknown"
        if "matchedFingerprints" in result and len(result["matchedFingerprints"]) > 0:
            identification_results.append({"domain": domain, "url": url, "libraries": result})

    return identify_scaffold(
        start_index, worker_id, endpoint="/identify/libraries/strings/bycompartment", appender=appender
    )


def combined(start_index, worker_id=None):
    def appender(identification_results, result, **kwargs):
        domain = kwargs["domain"] if "domain" in kwargs else "unknown"
        url = kwargs["url"] if "url" in kwargs else "unknown"
        has_map = kwargs["sourcemap"] is not None if "sourcemap" in result else None
        if "groundTruth" in result:
            identification_results.append({"domain": domain, "url": url, "libraries": result, "has_map": has_map})

    return identify_scaffold(start_index, worker_id, endpoint="/identify/combined/no_compartments", appender=appender, requires_sourcemap=False, cache=True)


def combined_with_compartments(start_index, worker_id=None):
    def appender(identification_results, result, **kwargs):
        domain = kwargs["domain"] if "domain" in kwargs else "unknown"
        url = kwargs["url"] if "url" in kwargs else "unknown"
        has_map = kwargs["sourcemap"] is not None if "sourcemap" in result else None
        if "groundTruth" in result:
            identification_results.append({"domain": domain, "url": url, "libraries": result, "has_map": has_map})

    return identify_scaffold(start_index, worker_id, endpoint="/identify/combined/compartments", appender=appender, requires_sourcemap=False, cache=True)


def without_truths(start_index, worker_id=None):
    def appender(identification_results, result, **kwargs):
        domain = kwargs["domain"] if "domain" in kwargs else "unknown"
        url = kwargs["url"] if "url" in kwargs else "unknown"
        if "similarities" in result:
            identification_results.append({"domain": domain, "url": url, "libraries": result})

    return identify_scaffold(start_index, worker_id, endpoint="/identify/without_truths/compartments", appender=appender, requires_sourcemap=False, cache=True)


def main():
    global FILESIZE, TOTAL, WORKER, STEPSIZE, HEADERS, BATCH_PER_FILE, BATCH_PER_DOMAIN

    shm = None
    counter = multiprocessing.Value("i", 0)

    scripts = {
        "get_urls": get_urls,
        "list_libraries": list_libraries,
        "extract_domain_artifacts": extract_domain_artifacts,
        "get_source_map_sources": get_source_map_sources,
        "identify_bundler": identify_bundler,
        "version_detection": version_detection,
        "version_detection_with_compartments": version_detection_with_compartments,
        "filter_source_map_sources": filter_source_map_sources,
        "library_string_identification": library_string_identification,
        "library_string_identification_with_compartments": library_string_identification_with_compartments,
        "bundler_compartment_identification": bundler_compartment_identification,
        "count_responsive_sites": count_responsive_sites,
        "combined": combined,
        "combined_with_compartments": combined_with_compartments,
        "without_truths": without_truths,
    }

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-s",
        "--script",
        type=str,
        required=True,
        help=f"Select an analysis script. Available scripts: {', '.join(scripts.keys())}",
    )
    parser.add_argument(
        "-H",
        "--headers",
        action="append",
        type=str,
        help=f"Add header(s) to all identification server requests. Example: -H X-Custom-Header=token",
    )
    parser.add_argument(
        "files",
        type=str,
        nargs="+",
        help="Dataset files in bson format",
    )
    parser.add_argument(
        "--total",
        type=int,
        help=f"Length of the dataset. Can be used for artificial truncation. Default: {TOTAL}",
    )
    parser.add_argument(
        "--batch-per-file",
        action="store_true",
        dest="batch_per_file",
        help=f"If set, wraps all results from a file into an extra array",
    )
    parser.add_argument(
        "--no-batch-per-domain",
        action="store_false",
        dest="batch_per_domain",
        help=f"If set, wraps results will be flattened if possible",
    )
    parser.add_argument(
        "--worker",
        type=int,
        help=f"Amount of subprocesses used. Default: {WORKER}",
    )
    parser.add_argument("--args", action="append", help="Arguments passed to script", default=[])
    args = parser.parse_args()
    if args.script not in scripts:
        print(f"Invalid script {args.script}", file=sys.stderr)
        print(f"Available scripts: {', '.join(scripts.keys())}", file=sys.stderr)
        exit(1)

    BATCH_PER_FILE = args.batch_per_file
    BATCH_PER_DOMAIN = args.batch_per_domain

    if args.headers:
        HEADERS = {}
        for header in args.headers:
            if "=" not in header:
                raise ValueError(f"Invalid header {header}. Missing '=' character")
            prefix, suffix = header.split("=", 1)
            HEADERS[prefix] = suffix

    if args.total:
        TOTAL = args.total
        STEPSIZE = TOTAL // WORKER + 1
    if args.worker:
        WORKER = args.worker
        STEPSIZE = TOTAL // WORKER + 1

    results = []
    for file in args.files:
        counter.value = 0
        try:
            FILESIZE = os.stat(file).st_size
            total_ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")

            if FILESIZE + 2e9 > total_ram:
                raise RuntimeError(f"File with size {FILESIZE} will probably not fit into RAM {total_ram}")

            print(f"Reading {file=} into RAM (this may take a while) ... ")
            shm = multiprocessing.shared_memory.SharedMemory(create=True, size=FILESIZE, name=SHM_NAME)
            bs = 1024 * 1024
            with open(file, mode="rb") as f:
                for offset in tqdm(range(0, FILESIZE, bs), unit="MByte"):
                    shm.buf[offset : offset + bs] = f.read(bs)

            print("Fetching sources ...")

            def initializer(ctr):
                globals()["counter"] = ctr

            with concurrent.futures.ProcessPoolExecutor(
                max_workers=WORKER, initializer=initializer, initargs=(counter,)
            ) as pool:
                futures: list[concurrent.futures.Future] = [
                    pool.submit(scripts[args.script], i, n, *args.args) for n, i in enumerate(range(0, TOTAL, STEPSIZE))
                ]
                progress = tqdm(total=TOTAL, unit="domains")
                while counter.value < TOTAL and not all(f.done() for f in futures):
                    progress.n = counter.value
                    progress.update(0)
                    time.sleep(0.4)
                progress.close()
                if BATCH_PER_FILE:
                    results.append(list(itertools.chain(*[future.result() if future.exception() is None else [] for future in futures])))
                else:
                    results.extend([future.result() if future.exception() is None else [] for future in futures])

        finally:
            if shm:
                shm.close()
                shm.unlink()

    with open("results.json", "w") as f:
        if BATCH_PER_FILE:
            json.dump(results, f, indent=2)
        else:
            json.dump(list(itertools.chain(*results)), f, indent=2)


if __name__ == "__main__":
    main()
