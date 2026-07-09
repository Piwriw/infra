// Extract batch 113 (index 112) data from batches.json
import { readFileSync, writeFileSync } from 'fs';

const batches = JSON.parse(readFileSync('/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batches.json', 'utf8'));

if (!batches.batches) {
  console.error('No batches array found');
  process.exit(1);
}

const batch = batches.batches.find(b => b.batchIndex === 113 || b.batchIndex === 112);
if (!batch) {
  console.error('Batch 113 not found');
  console.log('Available batch indices:', batches.batches.map(b => b.batchIndex).slice(0, 20));
  process.exit(1);
}

console.log('Found batch:', batch.batchIndex);
console.log('Files count:', batch.files?.length || 0);
console.log('Has import data:', !!batch.batchImportData);
console.log('Has neighborMap:', !!batch.neighborMap);

// Write extracted batch data
writeFileSync('/Users/joohwan/GolandProjects/infra/.understand-anything/tmp/batch-113-raw.json', JSON.stringify(batch, null, 2));
console.log('Written raw batch data');
