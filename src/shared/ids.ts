import { randomUUID } from 'node:crypto';
import type { Schema } from 'mongoose';

export function withSecureId(schema: Schema) {
  schema.add({
    id: { type: String, unique: true, index: true, default: () => randomUUID() },
  });

  const toJsonTransform = (doc: any, ret: any) => {
    if (ret._id !== undefined) delete ret._id;
    ret.id = ret.id || doc?.id || String(doc?._id ?? '');
    return ret;
  };

  schema.set('toJSON', { transform: toJsonTransform });
  schema.set('toObject', { transform: toJsonTransform });
  return schema;
}
