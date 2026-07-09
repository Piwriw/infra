#!/usr/bin/env python3
"""Split batch-40.json into parts based on node/edge limits."""
import json
import math
from collections import defaultdict

PROJECT_ROOT = '/Users/joohwan/GolandProjects/infra'

with open(f'{PROJECT_ROOT}/.understand-anything/intermediate/batch-40.json') as f:
    data = json.load(f)

nodes = data['nodes']
edges = data['edges']

# Group nodes by filePath
file_nodes = defaultdict(list)
for n in nodes:
    fp = n.get('filePath')
    if fp:
        file_nodes[fp].append(n)

# Files sorted alphabetically
sorted_files = sorted(file_nodes.keys())

NODE_LIMIT = 60
EDGE_LIMIT = 120

# Compute rough edge counts per file
def file_edge_count(fp):
    file_id = f"file:{fp}"
    cnt = 0
    for e in edges:
        src = e['source']
        tgt = e['target']
        if src == file_id or tgt == file_id:
            cnt += 1
    return cnt

file_sizes = {}
for fp in sorted_files:
    file_sizes[fp] = {
        'nodes': len(file_nodes[fp]),
        'edges': file_edge_count(fp),
    }

# Print summary
print("File sizes:")
for fp in sorted_files:
    print(f"  {fp}: nodes={file_sizes[fp]['nodes']}, edges={file_sizes[fp]['edges']}")

total_nodes = len(nodes)
total_edges = len(edges)
print(f"Total nodes: {total_nodes}, edges: {total_edges}")

# Compute parts needed
parts = max(math.ceil(total_nodes / NODE_LIMIT), math.ceil(total_edges / EDGE_LIMIT))
print(f"Parts needed: {parts}")

# Greedy partition: pack files into parts such that each part stays within limits
chunks = []
chunk_node_count = []
chunk_edge_count = []

for fp in sorted_files:
    sz = file_sizes[fp]
    if not chunks:
        # First file
        chunks.append([fp])
        chunk_node_count.append(sz['nodes'])
        chunk_edge_count.append(sz['edges'])
        continue
    # Try adding to current chunk
    if (chunk_node_count[-1] + sz['nodes'] <= NODE_LIMIT and
        chunk_edge_count[-1] + sz['edges'] <= EDGE_LIMIT):
        chunks[-1].append(fp)
        chunk_node_count[-1] += sz['nodes']
        chunk_edge_count[-1] += sz['edges']
    else:
        chunks.append([fp])
        chunk_node_count.append(sz['nodes'])
        chunk_edge_count.append(sz['edges'])

print(f"Parts: {len(chunks)}")
for i, (files, nc, ec) in enumerate(zip(chunks, chunk_node_count, chunk_edge_count)):
    print(f"  Part {i+1}: {len(files)} files, {nc} nodes, {ec} edges")

# Write each part
for i, chunk_files in enumerate(chunks, start=1):
    chunk_files_set = set(chunk_files)
    # Nodes belonging to this chunk
    chunk_nodes = [n for n in nodes if n.get('filePath') in chunk_files_set or n['id'].startswith('file:') and n['id'][5:] in chunk_files_set]
    # Recompute chunk node ids
    chunk_node_ids = {n['id'] for n in chunk_nodes}
    # Edges where source is in chunk nodes (target may be anywhere)
    chunk_edges = [e for e in edges if e['source'] in chunk_node_ids]

    output = {
        "nodes": chunk_nodes,
        "edges": chunk_edges,
    }

    suffix = f"-part-{i}" if len(chunks) > 1 else ""
    out_path = f'{PROJECT_ROOT}/.understand-anything/intermediate/batch-40{suffix}.json'
    with open(out_path, 'w') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"Wrote {out_path}: nodes={len(chunk_nodes)}, edges={len(chunk_edges)}")