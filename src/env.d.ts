import type { ReviewAPI } from '../shared/api';

declare global {
  interface Window {
    reviewAPI: ReviewAPI;
  }
}
