#!/usr/bin/env node
/**
 * Analyzes the E2B Infrastructure graph to compute structural signals
 * useful for tour design.
 */

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error('Usage: node ua-tour-analyze.js <input.json> <output.json>');
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(inputPath, 'utf-8');
} catch (err) {
  console.error(`Failed to read input: ${err.message}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error(`Failed to parse input JSON: ${err.message}`);
  process.exit(1);
}

// Adapter: the actual input file uses {fileNodes, allEdges}. The script
// spec calls for {nodes, edges, layers}. Build a normalized view.
const allNodes = data.nodes || data.fileNodes || [];
const allEdges = data.edges || data.allEdges || [];
let layers = data.layers || [];

// If layers is an array of objects with id/name/description and nodeIds,
// that's a flat list of layer definitions. Build a normalized version.
if (Array.isArray(layers) && layers.length && !layers[0].description) {
  // Already in {id, name, description} form
} else if (Array.isArray(layers) && layers.length && layers[0].nodeIds) {
  // Layered form: collapse to {id, name, description}
  layers = layers.map(l => ({
    id: l.id,
    name: l.name,
    description: l.description || '',
  }));
}

// Build a node index
const nodeById = new Map();
for (const n of allNodes) {
  nodeById.set(n.id, n);
}

// ---- A. Fan-In Ranking ----
const fanIn = new Map();
const fanOut = new Map();
for (const n of allNodes) {
  fanIn.set(n.id, 0);
  fanOut.set(n.id, 0);
}
for (const e of allEdges) {
  const src = e.source;
  const tgt = e.target;
  if (fanOut.has(src)) fanOut.set(src, fanOut.get(src) + 1);
  if (fanIn.has(tgt)) fanIn.set(tgt, fanIn.get(tgt) + 1);
}
const fanInRanking = Array.from(fanIn.entries())
  .map(([id, c]) => ({ id, fanIn: c, name: nodeById.get(id)?.name || id }))
  .sort((a, b) => b.fanIn - a.fanIn)
  .slice(0, 20);

const fanOutRanking = Array.from(fanOut.entries())
  .map(([id, c]) => ({ id, fanOut: c, name: nodeById.get(id)?.name || id }))
  .sort((a, b) => b.fanOut - a.fanOut)
  .slice(0, 20);

// ---- C. Entry Point Candidates ----
const entryFilenames = new Set([
  'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
  'server.ts', 'server.js', 'mod.rs', 'main.go', 'main.py', 'main.rs',
  'manage.py', 'app.py', 'wsgi.py', 'asgi.py', 'run.py', '__main__.py',
  'Application.java', 'Main.java', 'Program.cs', 'config.ru', 'index.php',
  'App.swift', 'Application.kt', 'main.cpp', 'main.c'
]);

const fanInThreshold25 = Math.floor(allNodes.length * 0.25);
const fanOutThreshold90 = Math.floor(allNodes.length * 0.10);

const entryScores = [];
for (const n of allNodes) {
  let score = 0;
  const fname = n.name || '';
  const fpath = n.filePath || '';
  const ntype = n.type || 'file';

  if (ntype === 'file') {
    if (entryFilenames.has(fname)) score += 3;
    // File at project root or one level deep (e.g., packages/api/main.go -> depth 2 from repo root)
    const parts = fpath.split('/');
    if (parts.length <= 3) score += 1;
    if (fanOut.get(n.id) >= fanOutThreshold90) score += 1;
    const fIn = fanIn.get(n.id);
    // Bottom 25% fan-in
    const sortedFanIn = Array.from(fanIn.values()).sort((a, b) => a - b);
    const lowFanInThreshold = sortedFanIn[Math.floor(sortedFanIn.length * 0.25)] || 0;
    if (fIn <= lowFanInThreshold) score += 1;
  } else if (ntype === 'document' || ntype === 'markdown') {
    if (fname === 'README.md' && fpath === 'README.md') score += 5;
    else if (fname.endsWith('.md') && fpath.split('/').length === 1) score += 2;
  }
  if (score > 0) {
    entryScores.push({ id: n.id, score, name: fname, summary: n.summary || '', type: ntype, filePath: fpath });
  }
}
entryScores.sort((a, b) => b.score - a.score);
const entryPointCandidates = entryScores.slice(0, 5);

// ---- D. Dependency Chains (BFS) ----
// Pick the top code entry point (not a document)
const codeEntry = entryScores.find(e => e.type === 'file');
const startNode = codeEntry ? codeEntry.id : null;

const bfsTraversal = { startNode: null, order: [], depthMap: {}, byDepth: {} };
if (startNode) {
  bfsTraversal.startNode = startNode;
  const visited = new Set([startNode]);
  const queue = [startNode];
  const depthMap = { [startNode]: 0 };
  const order = [startNode];
  while (queue.length) {
    const cur = queue.shift();
    const curDepth = depthMap[cur];
    for (const e of allEdges) {
      if (e.source !== cur) continue;
      if (e.type !== 'imports' && e.type !== 'calls') continue;
      const next = e.target;
      if (!nodeById.has(next)) continue;
      if (visited.has(next)) continue;
      visited.add(next);
      depthMap[next] = curDepth + 1;
      order.push(next);
      queue.push(next);
    }
  }
  bfsTraversal.order = order;
  bfsTraversal.depthMap = depthMap;
  const byDepth = {};
  for (const [id, d] of Object.entries(depthMap)) {
    const k = String(d);
    if (!byDepth[k]) byDepth[k] = [];
    byDepth[k].push(id);
  }
  bfsTraversal.byDepth = byDepth;
}

// ---- E. Non-Code File Inventory ----
// All input nodes are file-level (from fileNodes), so classify by package
const nonCodeFiles = {
  documentation: [],
  infrastructure: [],
  data: [],
  config: [],
};

// We don't have non-code nodes in the input, but we can identify documentation
// files (markdown) within the file nodes if any. Most files are .go.
for (const n of allNodes) {
  const fname = n.name || '';
  if (fname.endsWith('.md')) {
    nonCodeFiles.documentation.push({ id: n.id, name: fname, summary: n.summary || '' });
  }
}

// ---- F. Tightly Coupled Clusters ----
const clusters = [];
const adj = new Map();
for (const e of allEdges) {
  if (e.type !== 'imports' && e.type !== 'calls') continue;
  if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
  const src = e.source;
  const tgt = e.target;
  if (!adj.has(src)) adj.set(src, new Map());
  if (!adj.has(tgt)) adj.set(tgt, new Map());
  const srcMap = adj.get(src);
  const tgtMap = adj.get(tgt);
  srcMap.set(tgt, (srcMap.get(tgt) || 0) + 1);
  tgtMap.set(src, (tgtMap.get(src) || 0) + 1);
}

// Find pairs with bidirectional edges
const pairEdges = new Map();
for (const a of adj.keys()) {
  const neighbors = adj.get(a);
  for (const b of neighbors.keys()) {
    const bAdj = adj.get(b);
    if (bAdj && bAdj.has(a)) {
      const key = [a, b].sort().join('|');
      const count = neighbors.get(b) + bAdj.get(a);
      const existing = pairEdges.get(key) || 0;
      if (existing < count) pairEdges.set(key, count);
    }
  }
}

// Greedy cluster formation: start with strongest pair, expand
const sortedPairs = Array.from(pairEdges.entries())
  .sort((a, b) => b[1] - a[1]);

const used = new Set();
for (const [key, count] of sortedPairs) {
  if (clusters.length >= 10) break;
  const [a, b] = key.split('|');
  if (used.has(a) || used.has(b)) continue;
  const clusterNodes = [a, b];
  used.add(a); used.add(b);
  // Expand: find nodes connecting to 2+ members
  for (const candidate of adj.keys()) {
    if (used.has(candidate)) continue;
    let connectCount = 0;
    const candidateAdj = adj.get(candidate);
    if (candidateAdj) {
      for (const member of clusterNodes) {
        if (candidateAdj.has(member)) connectCount++;
      }
    }
    if (connectCount >= 2 && clusterNodes.length < 5) {
      clusterNodes.push(candidate);
      used.add(candidate);
    }
  }
  if (clusterNodes.length >= 2) {
    clusters.push({ nodes: clusterNodes, edgeCount: count });
  }
}

// ---- G. Layer List ----
const layerList = Array.isArray(layers) ? layers.map(l => ({
  id: l.id,
  name: l.name,
  description: l.description || '',
})) : [];

// ---- H. Node Summary Index ----
const nodeSummaryIndex = {};
for (const n of allNodes) {
  nodeSummaryIndex[n.id] = {
    name: n.name,
    type: n.type,
    summary: n.summary || '',
    filePath: n.filePath || '',
  };
}

// ---- Final output ----
const result = {
  scriptCompleted: true,
  entryPointCandidates,
  fanInRanking,
  fanOutRanking,
  bfsTraversal,
  nonCodeFiles,
  clusters,
  layers: { count: layerList.length, list: layerList },
  nodeSummaryIndex,
  totalNodes: allNodes.length,
  totalEdges: allEdges.length,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
console.log(`Analysis written to ${outputPath}`);
console.log(`Nodes: ${allNodes.length}, Edges: ${allEdges.length}`);
console.log(`Top entry: ${entryPointCandidates[0]?.id} (score ${entryPointCandidates[0]?.score})`);
console.log(`BFS start: ${bfsTraversal.startNode}, reached ${bfsTraversal.order.length} nodes`);
console.log(`Layers: ${layerList.length}`);