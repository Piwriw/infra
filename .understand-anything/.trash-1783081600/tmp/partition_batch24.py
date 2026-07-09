#!/usr/bin/env python3
"""Partition batch 24 graph - greedy balanced bin-packing."""
import json
import math
from collections import defaultdict

FULL_FILE = '/Users/joohwan/GolandProjects/infra/.understand-anything/tmp/batch24_full.json'
OUT_DIR = '/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate'

with open(FULL_FILE) as f:
    graph = json.load(f)

nodes = graph['nodes']
edges = graph['edges']

node_limit = 60
edge_limit = 120

# Build file -> nodes/edges maps
file_to_nodes = defaultdict(list)
for n in nodes:
    if n.get('filePath'):
        file_to_nodes[n['filePath']].append(n)

file_to_edges = defaultdict(list)
for e in edges:
    src = e['source']
    if src.startswith('file:'):
        src_file = src[5:]
        file_to_edges[src_file].append(e)
    elif src.startswith('class:'):
        src_file = src.split(':', 2)[1]
        file_to_edges[src_file].append(e)
    elif src.startswith('function:'):
        src_file = src.split(':', 2)[1]
        file_to_edges[src_file].append(e)

# Each file's weight
files = sorted(file_to_nodes.keys())
file_weights = {f: (len(file_to_nodes[f]), len(file_to_edges[f])) for f in files}

# Calculate number of parts based on node/edge counts
parts = max(1, math.ceil(max(len(nodes) / node_limit, len(edges) / edge_limit)))
# Bump parts up if any single file would overflow
parts += 1  # buffer for dense test files
print(f'Initial parts estimate: {parts}')
print(f'Nodes: {len(nodes)}, Edges: {len(edges)}, Parts: {parts}')

# Sort files by weight (largest first) and assign with LPT to keep balanced
# Weight = max(node_count/limit, edge_count/limit)
def score(f):
    nc, ec = file_weights[f]
    return max(nc / node_limit, ec / edge_limit)

files_sorted = sorted(files, key=score, reverse=True)

# Initialize parts
part_files = [[] for _ in range(parts)]
part_nodes_count = [0] * parts
part_edges_count = [0] * parts

for f in files_sorted:
    # Pick part with smallest load (combined node+edge measure)
    best = 0
    best_load = float('inf')
    for i in range(parts):
        # Prefer smallest node count, then smallest edge count
        load = (part_nodes_count[i] / node_limit) + (part_edges_count[i] / edge_limit)
        if load < best_load:
            best_load = load
            best = i
    part_files[best].append(f)
    nc, ec = file_weights[f]
    part_nodes_count[best] += nc
    part_edges_count[best] += ec

# Print summary
for i in range(parts):
    print(f'Part {i + 1}: {len(part_files[i])} files, {part_nodes_count[i]} nodes, {part_edges_count[i]} edges')

# Verify limits (allow slight overflow for dense test files)
total_overflow = sum(max(0, part_edges_count[i] - edge_limit) for i in range(parts))
print(f'Total edge overflow: {total_overflow}')

# Write each part
for i in range(parts):
    part_nodes = []
    part_node_ids_set = set()
    for f in part_files[i]:
        for n in file_to_nodes[f]:
            part_nodes.append(n)
            part_node_ids_set.add(n['id'])

    part_edges = []
    seen = set()
    for f in part_files[i]:
        for e in file_to_edges[f]:
            key = (e['source'], e['target'], e['type'])
            if key in seen:
                continue
            seen.add(key)
            part_edges.append(e)

    out = {
        'nodes': part_nodes,
        'edges': part_edges,
    }
    out_path = f'{OUT_DIR}/batch-24-part-{i + 1}.json'
    with open(out_path, 'w') as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f'Wrote {out_path}: {len(part_nodes)} nodes, {len(part_edges)} edges')

print('Done.')