import { Router } from 'express';
import multer from 'multer';
import type { UniMateService } from '../service';
import { captureTextSchema, captureVoiceFieldsSchema } from './schemas';
import { asyncRoute, parseInput } from './util';

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export function capturesRouter(service: UniMateService): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } });

  router.post(
    '/captures/text',
    asyncRoute(async (req, res) => {
      const body = parseInput(captureTextSchema, req.body);
      res.json(await service.captureText({ student_id: body.student_id, text: body.text, followup_plan_id: body.followup_plan_id }));
    }),
  );

  router.post(
    '/captures/voice',
    upload.single('audio'),
    asyncRoute(async (req, res) => {
      const fields = parseInput(captureVoiceFieldsSchema, req.body);
      const file = req.file;
      const audio = file ? { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype } : null;
      res.json(await service.captureVoice({ student_id: fields.student_id, audio, followup_plan_id: fields.followup_plan_id }));
    }),
  );

  return router;
}
