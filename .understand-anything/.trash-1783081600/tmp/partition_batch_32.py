#!/usr/bin/env python3
"""Partition batch-32 into parts based on file groups."""
import json
from pathlib import Path

data = json.load(open('/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batch-32.json'))
nodes = data['nodes']
edges = data['edges']

node_count = len(nodes)
edge_count = len(edges)
parts = max(1, -(-node_count // 60), -(-edge_count // 120))
print(f"Need {parts} parts")

# Get file-to-nodes mapping
file_nodes = {}
for n in nodes:
    if n['type'] in ('function', 'class'):
        fp = n.get('filePath')
        if fp:
            file_nodes.setdefault(fp, []).append(n)
    elif n['type'] == 'file':
        fp = n.get('filePath') or n['id'].replace('file:', '')
        file_nodes.setdefault(fp, []).append(n)

# Get unique files
files = sorted(file_nodes.keys())
print(f"Unique files: {len(files)}")

# Distribute files into parts by counting edges
# Simple approach: split files evenly
import math
per_part = math.ceil(len(files) / parts)
file_chunks = [files[i:i+per_part] for i in range(0, len(files), per_part)]
print(f"Chunks: {[len(c) for c in file_chunks]}")

# Each part: nodes for its files; edges where source is one of its files
for k, chunk in enumerate(file_chunks, 1):
    chunk_node_ids = set()
    for fp in chunk:
        for n in file_nodes[fp]:
            chunk_node_ids.add(n['id'])
    part_nodes = [n for n in nodes if n['id'] in chunk_node_ids]
    part_edges = [e for e in edges if e['source'] in chunk_node_ids]
    output = {'nodes': part_nodes, 'edges': part_edges}
    out_path = f'/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batch-32-part-{k}.json'
    Path(out_path).write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"Part {k}: {len(part_nodes)} nodes, {len(part_edges)} edges -> {out_path}")
