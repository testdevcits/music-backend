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
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return null;
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
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
