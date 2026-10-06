import { Schema, model } from 'mongoose';
const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });
export const Artist = model(
  'Artist',
  new Schema(
    { name: { type: String, required: true, index: true }, bio: String, imageFileId: String },
    { timestamps: true },
  ),
);
export const Album = model(
  'Album',
  new Schema(
    {
      title: { type: String, required: true },
      artist: { ...ref('Artist'), required: true },
      coverFileId: String,
      releaseDate: Date,
    },
    { timestamps: true },
  ),
);
export const Category = model(
  'Category',
  new Schema(
    {
      name: { type: String, required: true },
      slug: { type: String, required: true, unique: true },
      parent: { ...ref('Category'), default: null },
    },
    { timestamps: true },
  ),
);
export const Tag = model(
  'Tag',
  new Schema(
    {
      name: { type: String, required: true },
      slug: { type: String, required: true, unique: true },
    },
    { timestamps: true },
  ),
);
const songSchema = new Schema(
  {
    title: { type: String, required: true },
    artist: { ...ref('Artist'), required: true },
    album: ref('Album'),
    language: { type: String, required: true },
    duration: { type: Number, default: 0 },
    lyrics: String,
    coverFileId: String,
    coverMime: String,
    categories: [ref('Category')],
    tags: [ref('Tag')],
    published: { type: Boolean, default: false },
    processing: {
      type: String,
      enum: ['pending', 'processing', 'ready', 'failed'],
      default: 'pending',
    },
    sourceFileId: { type: String, select: false },
    audioVersion: String,
    processingUpload: String,
    audio: [
      {
        _id: false,
        quality: { type: String, enum: ['64', '128', '192'] },
        fileId: String,
        bytes: Number,
        mime: String,
      },
    ],
  },
  { timestamps: true },
);
songSchema.index(
  { title: 'text', lyrics: 'text' },
  { default_language: 'none', language_override: 'textIndexLanguage' },
);
songSchema.index({ published: 1, categories: 1, createdAt: -1 });
songSchema.index({ artist: 1, album: 1 });
songSchema.index({ tags: 1 });
export const Song = model('Song', songSchema);
const licenseSchema = new Schema(
  {
    song: { ...ref('Song'), required: true, unique: true },
    holder: { type: String, required: true },
    reference: String,
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    streaming: { type: Boolean, default: true },
    offline: { type: Boolean, default: false },
    territories: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const License = model('License', licenseSchema);
export const Upload = model(
  'Upload',
  new Schema(
    {
      song: { ...ref('Song'), required: true },
      fileId: { type: String, required: true, unique: true },
      kind: { type: String, enum: ['audio', 'cover'], required: true },
      contentType: { type: String, required: true },
      bytes: { type: Number, required: true },
      completed: { type: Boolean, default: false },
      expiresAt: { type: Date, required: true },
    },
    { timestamps: true },
  ),
);
