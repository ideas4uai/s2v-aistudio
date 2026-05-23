export const quotaService = {
  checkQuota: async () => true,
  consumeQuota: async () => {}
};

export class QuotaService {
  static async incrementAiImage() {}
  static async incrementAudio() {}
}
