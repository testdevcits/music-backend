import { connect, disconnect } from '../src/infrastructure/connections';
import { Category, Song, Tag } from '../src/modules/catalog/models';

async function main() {
  if (process.env.DEVOTIONAL_CATALOG_SEED_CONFIRM !== 'YES') {
    throw new Error('Set DEVOTIONAL_CATALOG_SEED_CONFIRM=YES to add devotional categories and tags.');
  }

  await connect();
  const bhakti = await Category.findOneAndUpdate(
    { slug: 'bhakti' },
    { $setOnInsert: { name: 'Bhakti', slug: 'bhakti', parent: null } },
    { upsert: true, new: true },
  );

  const categoryRows = [
    { name: 'Hanuman Bhajans', slug: 'hanuman-bhajans' },
    { name: 'Krishna Bhajans', slug: 'krishna-bhajans' },
    { name: 'Aarti', slug: 'aarti' },
    { name: 'Mantra', slug: 'mantra' },
    { name: 'Hindi Devotional', slug: 'hindi-devotional' },
  ];
  const categories = await Promise.all(categoryRows.map(({ name, slug }) =>
    Category.findOneAndUpdate(
      { slug },
      { $setOnInsert: { name, slug, parent: bhakti._id } },
      { upsert: true, new: true },
    ),
  ));
  const tagRows = [
    { name: 'Bhajan', slug: 'bhajan' },
    { name: 'Devotional', slug: 'devotional' },
    { name: 'Spiritual', slug: 'spiritual' },
  ];
  const tags = await Promise.all(tagRows.map(({ name, slug }) =>
    Tag.findOneAndUpdate({ slug }, { $setOnInsert: { name, slug } }, { upsert: true, new: true }),
  ));

  const existingHanumanSong = await Song.findOne({ title: /^hanuman chalisa$/i });
  if (existingHanumanSong) {
    const matchedCategories = categories.filter((category) =>
      ['hanuman-bhajans', 'hindi-devotional'].includes(category.slug),
    );
    await Song.updateOne(
      { _id: existingHanumanSong._id },
      {
        $addToSet: {
          categories: { $each: matchedCategories.map((category) => category._id) },
          tags: { $each: tags.map((tag) => tag._id) },
        },
        $set: { genre: existingHanumanSong.genre || 'Devotional' },
      },
    );
    console.log(`Updated existing "${existingHanumanSong.title}" metadata with devotional categories/tags; audio and license were not changed.`);
  } else {
    console.log('No Hanuman Chalisa song found; categories/tags were created without inventing a song or license.');
  }
  console.log(`Seeded ${categories.length + 1} categories and ${tags.length} tags.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(disconnect);
