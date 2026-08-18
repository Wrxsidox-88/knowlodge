import { Router } from 'express';
import { answerQuestion } from '../services/qa.js';

export const qaRouter = Router();

qaRouter.post('/', async (req, res, next) => {
  try {
    const { question } = req.body || {};
    const result = await answerQuestion(question, req.user?.id ?? null);
    res.json(result);
  } catch (e) {
    next(e);
  }
});
