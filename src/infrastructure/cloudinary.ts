import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env';

export function hasCloudinaryConfig() {
  return Boolean(
    env.CLOUDINARY_CLOUD_NAME &&
      env.CLOUDINARY_API_KEY &&
      env.CLOUDINARY_API_SECRET,
  );
}

export async function uploadCoverToCloudinary(data: Buffer, songId: string) {
  if (!hasCloudinaryConfig()) return null;
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });

  const result = await new Promise<{ url: string; publicId: string }>((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        folder: 'music-platform/covers',
        resource_type: 'image',
        public_id: `song-${songId}-${Date.now()}`,
      },
      (error, uploadResult) => {
        if (error) {
          reject(error);
          return;
        }
        if (!uploadResult?.secure_url || !uploadResult.public_id) {
          reject(new Error('CLOUDINARY_UPLOAD_FAILED'));
          return;
        }
        resolve({
          url: uploadResult.secure_url,
          publicId: uploadResult.public_id,
        });
      },
    );
    upload.end(data);
  });

  return result;
}
