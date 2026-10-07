import { connect, disconnect } from '../src/infrastructure/connections';
import { Category } from '../src/modules/catalog/models';
import { Plan } from '../src/modules/billing/models';
import { User } from '../src/modules/auth/models';
import bcrypt from 'bcryptjs';
async function main() {
  await connect();
  for (const name of [
    'Bhakti',
    'Hanuman',
    'Krishna',
    'Shiv',
    'Ram',
    'Bollywood',
    'Classical',
    'Meditation',
    'Kids',
    'Instrumental',
    'Regional',
    'Aarti',
    'Mantra',
    'Bhajan',
  ]) {
    const parent = ['Hanuman', 'Krishna', 'Shiv', 'Ram', 'Aarti', 'Mantra', 'Bhajan'].includes(name)
      ? await Category.findOne({ slug: 'bhakti' })
      : null;
    await Category.updateOne(
      { slug: name.toLowerCase() },
      { $setOnInsert: { name, slug: name.toLowerCase(), parent: parent?._id ?? null } },
      { upsert: true },
    );
  }
  await Plan.updateOne(
    { slug: 'premium' },
    {
      $setOnInsert: {
        name: 'Premium',
        slug: 'premium',
        priceMinor: 9900,
        currency: 'INR',
        offlineLimit: 100,
        deviceLimit: 3,
        offlineDays: 30,
        qualities: ['64', '128', '192'],
        active: true,
      },
    },
    { upsert: true },
  );
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    if (
      Buffer.byteLength(process.env.ADMIN_PASSWORD) < 8 ||
      Buffer.byteLength(process.env.ADMIN_PASSWORD) > 72
    )
      throw Error('Admin password must be 8–72 bytes');
    await User.updateOne(
      { email: process.env.ADMIN_EMAIL.toLowerCase() },
      {
        $set: {
          email: process.env.ADMIN_EMAIL.toLowerCase(),
          name: 'Administrator',
          role: 'admin',
          disabled: false,
          passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
        },
      },
      { upsert: true },
    );
  }
  console.log('Seed complete; configured administrator has been synchronized');
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(disconnect);
