import mongoose from 'mongoose';
import { connect, disconnect } from '../src/infrastructure/connections';
import '../src/modules/auth/models';
import '../src/modules/catalog/models';
import '../src/modules/billing/models';
import '../src/modules/library/models';
import '../src/modules/playback/models';
async function main() {
  await connect();
  for (const model of Object.values(mongoose.models)) {
    await model.createIndexes();
    console.log(`Indexes ready: ${model.modelName}`);
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(disconnect);
