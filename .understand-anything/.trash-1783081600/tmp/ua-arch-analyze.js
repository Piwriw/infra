#!/usr/bin/env node
// Architecture analysis script for E2B Infrastructure
// Reads file nodes and edges, computes structural patterns.

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error('Usage: ua-arch-analyze.js <input.json> <output.json>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const { fileNodes, importEdges, allEdges } = data;

// ---- A. Directory Grouping ----
// E2B has multiple top-level prefixes: packages/, iac/, tests/, spec/, docs/, scripts/, .github/
// Group by smart prefix paths to map files to packages and subsystems.
function computeDirectoryGroup(filePath) {
  const parts = filePath.split('/');
  if (parts[0] === 'packages' && parts.length >= 2) {
    const pkg = parts[1];
    if (pkg === 'shared' && parts.length >= 4) {
      return 'shared/' + parts[3];
    }
    if (pkg === 'orchestrator' && parts.length >= 4 && parts[2] === 'internal') {
      return 'orchestrator/internal/' + parts[3];
    }
    if (pkg === 'orchestrator' && parts.length >= 3 && parts[2] === 'cmd') {
      return 'orchestrator/cmd';
    }
    if (pkg === 'api' && parts.length >= 4 && parts[2] === 'internal') {
      return 'api/internal/' + parts[3];
    }
    if (pkg === 'db') {
      if (parts[2] === 'migrations') return 'db/migrations';
      if (parts[2] === 'queries') return 'db/queries';
      if (parts[2] === 'pkg') return 'db/pkg';
      if (parts[2] === 'schema') return 'db/schema';
      if (parts[2] === 'client') return 'db/client';
      if (parts[2] === 'scripts') return 'db/scripts';
      return 'db/root';
    }
    if (pkg === 'envd') {
      if (parts[2] === 'internal') return 'envd/internal';
      if (parts[2] === 'spec') return 'envd/spec';
      if (parts[2] === 'pkg') return 'envd/pkg';
      return 'envd/root';
    }
    if (pkg === 'clickhouse') {
      if (parts[2] === 'migrations') return 'clickhouse/migrations';
      if (parts[2] === 'pkg') return 'clickhouse/pkg';
      if (parts[2] === 'local') return 'clickhouse/local';
      return 'clickhouse/root';
    }
    if (pkg === 'dashboard-api' && parts.length >= 4 && parts[2] === 'internal') {
      return 'dashboard-api/internal/' + parts[3];
    }
    if (pkg === 'docker-reverse-proxy' && parts.length >= 4 && parts[2] === 'internal') {
      return 'docker-reverse-proxy/internal';
    }
    if (pkg === 'client-proxy' && parts.length >= 4 && parts[2] === 'internal') {
      return 'client-proxy/internal';
    }
    if (pkg === 'auth' && parts.length >= 3 && parts[2] === 'pkg') {
      return 'auth/pkg';
    }
    return 'packages/' + pkg;
  }
  if (parts[0] === 'iac') {
    if (parts.length >= 2) {
      const provider = parts[1];
      if (parts.length >= 3) {
        if (parts[2] === 'nomad' && parts.length >= 5) {
          return 'iac/' + provider + '/nomad/' + parts[4];
        }
        if (parts[2] === 'modules' && parts.length >= 4) {
          return 'iac/' + provider + '/modules/' + parts[3];
        }
        if (provider === 'modules' && parts.length >= 3) {
          return 'iac/modules/' + parts[2];
        }
        if (provider === 'nomad-cluster-disk-image' && parts.length >= 3) {
          return 'iac/nomad-cluster-disk-image/' + parts[2];
        }
        return 'iac/' + provider + '/' + parts[2];
      }
      return 'iac/' + provider;
    }
    return 'iac/root';
  }
  if (parts[0] === 'tests') {
    if (parts.length >= 3) return 'tests/' + parts[1];
    return 'tests/root';
  }
  if (parts[0] === 'spec') return 'spec';
  if (parts[0] === 'docs') return 'docs';
  if (parts[0] === 'scripts') return 'scripts';
  if (parts[0] === '.github') return '.github';
  if (parts[0] === 'fixtures') return 'fixtures';
  return 'root';
}

const directoryGroups = {};
for (const n of fileNodes) {
  const g = computeDirectoryGroup(n.filePath);
  if (!directoryGroups[g]) directoryGroups[g] = [];
  directoryGroups[g].push(n.id);
}

// ---- B. Node Type Grouping ----
const nodeTypeGroups = {};
for (const n of fileNodes) {
  const t = n.type;
  if (!nodeTypeGroups[t]) nodeTypeGroups[t] = [];
  nodeTypeGroups[t].push(n.id);
}

// ---- C. Import Adjacency Matrix ----
const fileFanIn = {};
const fileFanOut = {};
for (const e of importEdges) {
  fileFanOut[e.source] = (fileFanOut[e.source] || 0) + 1;
  fileFanIn[e.target] = (fileFanIn[e.target] || 0) + 1;
}

// ---- D. Cross-Category Dependency Analysis ----
const crossCategoryEdges = {};
for (const e of allEdges) {
  const srcNode = fileNodes.find(n => n.id === e.source);
  const tgtNode = fileNodes.find(n => n.id === e.target);
  if (!srcNode || !tgtNode) continue;
  const key = `${srcNode.type}->${tgtNode.type}:${e.type}`;
  if (!crossCategoryEdges[key]) crossCategoryEdges[key] = 0;
  crossCategoryEdges[key]++;
}
const crossCategoryList = Object.entries(crossCategoryEdges).map(([k, count]) => {
  const [path, edgeType] = k.split(':');
  const [fromType, toType] = path.split('->');
  return { fromType, toType, edgeType, count };
}).sort((a, b) => b.count - a.count);

// ---- E. Inter-Group Import Frequency ----
const interGroupImports = {};
for (const e of importEdges) {
  const srcNode = fileNodes.find(n => n.id === e.source);
  const tgtNode = fileNodes.find(n => n.id === e.target);
  if (!srcNode || !tgtNode) continue;
  const fromGroup = computeDirectoryGroup(srcNode.filePath);
  const toGroup = computeDirectoryGroup(tgtNode.filePath);
  if (fromGroup === toGroup) continue;
  const key = `${fromGroup}->${toGroup}`;
  if (!interGroupImports[key]) interGroupImports[key] = 0;
  interGroupImports[key]++;
}
const interGroupList = Object.entries(interGroupImports)
  .map(([k, count]) => {
    const [from, to] = k.split('->');
    return { from, to, count };
  })
  .sort((a, b) => b.count - a.count);

// ---- F. Intra-Group Import Density ----
const intraGroupEdges = {};
for (const e of importEdges) {
  const srcNode = fileNodes.find(n => n.id === e.source);
  const tgtNode = fileNodes.find(n => n.id === e.target);
  if (!srcNode || !tgtNode) continue;
  const g = computeDirectoryGroup(srcNode.filePath);
  if (g === computeDirectoryGroup(tgtNode.filePath)) {
    intraGroupEdges[g] = (intraGroupEdges[g] || 0) + 1;
  }
}
const intraGroupDensity = {};
for (const g of Object.keys(directoryGroups)) {
  const internalEdges = intraGroupEdges[g] || 0;
  // Total edges where this group appears (in or out)
  let totalEdges = 0;
  for (const e of importEdges) {
    const srcNode = fileNodes.find(n => n.id === e.source);
    const tgtNode = fileNodes.find(n => n.id === e.target);
    if (!srcNode || !tgtNode) continue;
    if (computeDirectoryGroup(srcNode.filePath) === g || computeDirectoryGroup(tgtNode.filePath) === g) {
      totalEdges++;
    }
  }
  intraGroupDensity[g] = {
    internalEdges,
    totalEdges,
    density: totalEdges > 0 ? +(internalEdges / totalEdges).toFixed(3) : 0
  };
}

// ---- G. Directory Pattern Matching ----
const patternRules = [
  { patterns: ['routes', 'api', 'controllers', 'endpoints', 'handlers'], label: 'api' },
  { patterns: ['services', 'core', 'lib', 'domain', 'logic'], label: 'service' },
  { patterns: ['models', 'db', 'data', 'persistence', 'repository', 'entities'], label: 'data' },
  { patterns: ['components', 'views', 'pages', 'ui', 'layouts', 'screens'], label: 'ui' },
  { patterns: ['middleware', 'plugins', 'interceptors', 'guards'], label: 'middleware' },
  { patterns: ['utils', 'helpers', 'common', 'shared', 'tools'], label: 'utility' },
  { patterns: ['config', 'constants', 'env', 'settings'], label: 'config' },
  { patterns: ['__tests__', 'test', 'tests', 'spec', 'specs'], label: 'test' },
  { patterns: ['types', 'interfaces', 'schemas', 'contracts', 'dtos'], label: 'types' },
  { patterns: ['hooks'], label: 'hooks' },
  { patterns: ['store', 'state', 'reducers', 'actions', 'slices'], label: 'state' },
  { patterns: ['assets', 'static', 'public'], label: 'assets' },
  { patterns: ['migrations'], label: 'data' },
  { patterns: ['management', 'commands'], label: 'config' },
  { patterns: ['templatetags'], label: 'utility' },
  { patterns: ['signals'], label: 'service' },
  { patterns: ['serializers'], label: 'api' },
  { patterns: ['cmd'], label: 'entry' },
  { patterns: ['internal'], label: 'service' },
  { patterns: ['pkg'], label: 'utility' },
  { patterns: ['main/java'], label: 'service' },
  { patterns: ['test/java'], label: 'test' },
  { patterns: ['dto', 'request', 'response'], label: 'types' },
  { patterns: ['entity'], label: 'data' },
  { patterns: ['controller'], label: 'api' },
  { patterns: ['routers'], label: 'api' },
  { patterns: ['composables'], label: 'service' },
  { patterns: ['blueprints'], label: 'api' },
  { patterns: ['mailers', 'jobs', 'channels'], label: 'service' },
  { patterns: ['bin'], label: 'entry' },
  { patterns: ['docs', 'documentation', 'wiki'], label: 'documentation' },
  { patterns: ['deploy', 'deployment', 'infra', 'infrastructure'], label: 'infrastructure' },
  { patterns: ['.github', '.gitlab', '.circleci'], label: 'ci-cd' },
  { patterns: ['k8s', 'kubernetes', 'helm', 'charts'], label: 'infrastructure' },
  { patterns: ['terraform', 'tf'], label: 'infrastructure' },
  { patterns: ['docker'], label: 'infrastructure' },
  { patterns: ['sql', 'database', 'schema'], label: 'data' }
];

function matchDirectoryPattern(dirName) {
  for (const rule of patternRules) {
    for (const p of rule.patterns) {
      if (dirName === p || dirName.startsWith(p + '/') || dirName.endsWith('/' + p)) {
        return rule.label;
      }
    }
  }
  return null;
}

const patternMatches = {};
for (const g of Object.keys(directoryGroups)) {
  const segs = g.split('/');
  let matched = null;
  for (const s of segs) {
    const m = matchDirectoryPattern(s);
    if (m) { matched = m; break; }
  }
  if (matched) patternMatches[g] = matched;
}

// File-level patterns
function matchFilePattern(name, filePath) {
  if (/\.test\.|_test\.go|Test\.java|_spec\.rb|Test\.php|Tests\.cs|test_\.py|test_.*\.py|spec\..*/.test(name) || /^test_.*\.py$/.test(name) || /_test\.go$/.test(name) || /Test\.java$/.test(name)) {
    return 'test';
  }
  if (/\.d\.ts$/.test(name)) return 'types';
  if ((name === 'index.ts' || name === 'index.js' || name === '__init__.py') && filePath.split('/').length > 1) {
    return 'entry';
  }
  if (name === 'manage.py') return 'entry';
  if (name === 'wsgi.py' || name === 'asgi.py') return 'config';
  if (name === 'main.go' && filePath.match(/^packages\/[^/]+\/cmd\//)) return 'entry';
  if (name === 'main.go') return 'entry';
  if (name === 'main.rs' || name === 'lib.rs') return 'entry';
  if (name === 'Application.java' || name === 'Program.cs') return 'entry';
  if (name === 'config.ru') return 'entry';
  if (['Cargo.toml', 'go.mod', 'go.sum', 'Gemfile', 'pom.xml', 'build.gradle', 'composer.json'].includes(name)) return 'config';
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.') || name.startsWith('docker-compose') || name === 'docker-bake.hcl') return 'infrastructure';
  if (/\.tf$/.test(name) || /\.tfvars$/.test(name)) return 'infrastructure';
  if (filePath.startsWith('.github/workflows/') || name === 'Jenkinsfile' || name === '.gitlab-ci.yml') return 'ci-cd';
  if (/\.sql$/.test(name)) return 'data';
  if (/\.graphql$/.test(name) || /\.gql$/.test(name) || /\.proto$/.test(name)) return 'types';
  if (/\.md$/.test(name) || /\.rst$/.test(name)) return 'documentation';
  if (name === 'Makefile') return 'infrastructure';
  return null;
}

const filePatternMatches = {};
for (const n of fileNodes) {
  if (n.type === 'file') {
    const m = matchFilePattern(n.name, n.filePath);
    if (m) filePatternMatches[n.id] = m;
  }
}

// ---- H. Deployment Topology Detection ----
const infraFiles = [];
let hasDockerfile = false, hasCompose = false, hasK8s = false, hasTerraform = false, hasCI = false;
for (const n of fileNodes) {
  if (n.name === 'Dockerfile' || n.name.startsWith('Dockerfile.') || n.name === 'debug.Dockerfile' || n.name === 'test.Dockerfile' || n.name === 'generate.Dockerfile' || n.name === 'e2b.Dockerfile' || /docker-compose.*\.yml$/.test(n.name) || /docker-compose.*\.yaml$/.test(n.name)) {
    hasDockerfile = true;
    infraFiles.push(n.filePath);
  }
  if (/docker-compose/.test(n.name)) hasCompose = true;
  if (n.filePath.includes('/k8s/')) hasK8s = true;
  if (/\.tf$/.test(n.name) || n.name === 'docker-bake.hcl' || /\.nomad\.hcl$/.test(n.name) || /\.hcl$/.test(n.name)) hasTerraform = true;
  if (n.filePath.startsWith('.github/workflows/') || n.name === 'Jenkinsfile') hasCI = true;
}

// ---- I. Data Pipeline Detection ----
const schemaFiles = [];
const migrationFiles = [];
const dataModelFiles = [];
const apiHandlerFiles = [];
for (const n of fileNodes) {
  if (/\.proto$/.test(n.name)) schemaFiles.push(n.filePath);
  if (/\.sql$/.test(n.name) && (n.filePath.includes('migrations/') || n.type === 'table')) migrationFiles.push(n.filePath);
  if (n.type === 'table') dataModelFiles.push(n.filePath);
  if (n.filePath.includes('api/handlers/') || n.filePath.includes('api/internal/handlers/')) apiHandlerFiles.push(n.filePath);
}

// ---- J. Documentation Coverage ----
let groupsWithDocs = 0;
const undocumentedGroups = [];
for (const g of Object.keys(directoryGroups)) {
  const hasDoc = fileNodes.some(n => n.type === 'document' && computeDirectoryGroup(n.filePath) === g);
  if (hasDoc) groupsWithDocs++;
  else undocumentedGroups.push(g);
}

// ---- K. Dependency Direction ----
// For each pair of groups with imports between them, determine dominant direction.
const pairCounts = {};
for (const e of importEdges) {
  const srcNode = fileNodes.find(n => n.id === e.source);
  const tgtNode = fileNodes.find(n => n.id === e.target);
  if (!srcNode || !tgtNode) continue;
  const fromGroup = computeDirectoryGroup(srcNode.filePath);
  const toGroup = computeDirectoryGroup(tgtNode.filePath);
  if (fromGroup === toGroup) continue;
  const key = [fromGroup, toGroup].sort().join('|');
  if (!pairCounts[key]) pairCounts[key] = { a: 0, b: 0, aGroup: fromGroup, bGroup: toGroup };
  if (fromGroup < toGroup) pairCounts[key].a++;
  else pairCounts[key].b++;
}
const dependencyDirection = [];
for (const { a, b, aGroup, bGroup } of Object.values(pairCounts)) {
  if (a > b) {
    dependencyDirection.push({ dependent: aGroup, dependsOn: bGroup, aCount: a, bCount: b });
  } else if (b > a) {
    dependencyDirection.push({ dependent: bGroup, dependsOn: aGroup, aCount: a, bCount: b });
  }
}
dependencyDirection.sort((x, y) => (y.aCount + y.bCount) - (x.aCount + x.bCount));

// ---- Output ----
const fileStats = {
  totalFileNodes: fileNodes.length,
  filesPerGroup: Object.fromEntries(Object.entries(directoryGroups).map(([k, v]) => [k, v.length])),
  nodeTypeCounts: Object.fromEntries(Object.entries(nodeTypeGroups).map(([k, v]) => [k, v.length]))
};

const result = {
  scriptCompleted: true,
  directoryGroups,
  nodeTypeGroups,
  crossCategoryEdges: crossCategoryList,
  interGroupImports: interGroupList.slice(0, 100),
  intraGroupDensity,
  patternMatches,
  filePatternMatches,
  deploymentTopology: {
    hasDockerfile,
    hasCompose,
    hasK8s,
    hasTerraform,
    hasCI,
    infraFiles
  },
  dataPipeline: {
    schemaFiles,
    migrationFiles: migrationFiles.slice(0, 50),
    dataModelFiles: dataModelFiles.slice(0, 30),
    apiHandlerFiles: apiHandlerFiles.slice(0, 30)
  },
  docCoverage: {
    groupsWithDocs,
    totalGroups: Object.keys(directoryGroups).length,
    coverageRatio: +(groupsWithDocs / Object.keys(directoryGroups).length).toFixed(3),
    undocumentedGroups
  },
  dependencyDirection: dependencyDirection.slice(0, 80),
  fileStats,
  fileFanIn: Object.fromEntries(Object.entries(fileFanIn).sort((a, b) => b[1] - a[1]).slice(0, 50)),
  fileFanOut: Object.fromEntries(Object.entries(fileFanOut).sort((a, b) => b[1] - a[1]).slice(0, 50))
};

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log('Analysis complete. Output:', outputPath);
console.log('Total file nodes:', fileStats.totalFileNodes);
console.log('Top groups:', Object.entries(fileStats.filesPerGroup).sort((a, b) => b[1] - a[1]).slice(0, 20));
