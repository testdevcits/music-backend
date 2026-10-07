import { Schema, model } from 'mongoose';
import { withSecureId } from '../../shared/ids';

const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });

export const Artist = model(
  'Artist',
  withSecureId(
    new Schema(
      { name: { type: String, required: true, index: true }, bio: String, imageFileId: String, imageUrl: String, imagePublicId: String },
      { timestamps: true },
    ),
  ),
);

export const Album = model(
  'Album',
  withSecureId(
    new Schema(
      {
        title: { type: String, required: true },
        artist: { ...ref('Artist'), required: true },
        coverFileId: String,
        coverUrl: String,
        coverPublicId: String,
        releaseDate: Date,
      },
      { timestamps: true },
    ),
  ),
);

export const Category = model(
  'Category',
  withSecureId(
    new Schema(
      {
        name: { type: String, required: true },
        slug: { type: String, required: true, unique: true },
        parent: { ...ref('Category'), default: null },
        imageUrl: String,
        imagePublicId: String,
      },
      { timestamps: true },
    ),
  ),
);

export const Tag = model(
  'Tag',
  withSecureId(
    new Schema(
      {
        name: { type: String, required: true },
        slug: { type: String, required: true, unique: true },
      },
      { timestamps: true },
    ),
  ),
);

const songSchema = withSecureId(
  new Schema(
    {
      title: { type: String, required: true },
      artist: { ...ref('Artist'), required: true },
      album: ref('Album'),
      language: { type: String, required: true },
      duration: { type: Number, default: 0 },
      lyrics: String,
      genre: String,
      year: Number,
      trackNumber: Number,
      discNumber: Number,
      format: String,
      bitrate: Number,
      artwork: String,
      url: String,
      coverUrl: String,
      coverPublicId: String,
      coverFileId: String,
      coverMime: String,
      provider: String,
      externalSongId: String,
      sourceLicense: String,
      sourceUrl: String,
      rightsHolder: String,
      isFavorite: { type: Boolean, default: false },
      playCount: { type: Number, default: 0 },
      lastPlayedAt: Date,
      dateAdded: Date,
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
          url: String,
          publicId: String,
          bytes: Number,
          mime: String,
        },
      ],
    },
    { timestamps: true },
  ),
);
songSchema.index(
  { title: 'text', lyrics: 'text' },
  { default_language: 'none', language_override: 'textIndexLanguage' },
);
songSchema.index({ published: 1, categories: 1, createdAt: -1 });
songSchema.index({ artist: 1, album: 1 });
songSchema.index({ tags: 1 });
songSchema.index({ provider: 1, externalSongId: 1 }, { unique: true, sparse: true });
export const Song = model('Song', songSchema);

const licenseSchema = withSecureId(
  new Schema(
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
      source: { type: String, enum: ['artist', 'label', 'provider', 'public-domain', 'creative-commons', 'other'], default: 'other' },
      licenseName: String,
      evidenceUrl: String,
      documentReference: String,
      inAppStreaming: { type: Boolean, default: false },
      audioHosting: { type: Boolean, default: false },
      commercialUse: { type: Boolean, default: false },
      artworkUse: { type: Boolean, default: false },
      lyricsUse: { type: Boolean, default: false },
      verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
      verificationNotes: String,
      verifiedBy: ref('User'),
      verifiedAt: Date,
    },
    { timestamps: true },
  ),
);
export const License = model('License', licenseSchema);

export const Upload = model(
  'Upload',
  withSecureId(
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
  ),
);
