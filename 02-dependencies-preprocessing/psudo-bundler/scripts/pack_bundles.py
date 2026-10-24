import argparse
import concurrent.futures
import csv
import functools
import json
import lzma
import os
from multiprocessing import Lock

import bson

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input", type=str, required=True, help="Input directory with bundles and source maps")
    parser.add_argument("-m", "--metafile", type=str, required=True, help="Metadata")
    parser.add_argument("-o", "--output", type=str, required=True, help="Output dataset file")
    args = parser.parse_args()

    def group_files(acc, next):
        if len(acc) == 0:
            acc.append([next])
        else:
            last = acc[-1][-1]
            if last.split(".")[0] == next.split(".")[0]:
                acc[-1].append(next)
            else:
                acc.append([next])
        return acc

    with open(args.metafile, "r") as f:
        meta = list(csv.reader(f))

    def process_file_set(input_file_set):
        data = []
        print(f"Current: {input_file_set=}")
        num = int(input_file_set[0].split(".")[0].split("-")[-1], 10)
        for input_file in input_file_set:
            if "LICENSE" in input_file:
                continue
            with open(os.path.join(args.input, input_file), "r") as f:
                obj = {
                    "url": f"local://{input_file}",
                    "status": 200,
                    "body": f.read(),
                }
                if not input_file.endswith(".map"):
                    obj["sourceMapUrl"] = f"local://{input_file}.map"
                data.append(obj)

        doc = {
            "meta": {
                "domain": f"lab.generated/{meta[num]}",
                "length": len(data)
            },
            "data": lzma.compress(json.dumps(data).encode())
        }

        return bson.encode(doc)

    with open(args.output, "wb") as output:
        lock = Lock()
        input_file_sets = functools.reduce(group_files, sorted(os.listdir(args.input)), [])
        with concurrent.futures.ProcessPoolExecutor() as executor:
            for doc in executor.map(process_file_set, input_file_sets):
                with lock:
                    output.write(doc)

