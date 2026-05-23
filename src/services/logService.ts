export const logService = {
  log: (message: string) => console.log(message),
  error: (message: string, error?: any) => console.error(message, error)
};

export const logUserEvent = async (event: string, projectId: string, metadata: any) => {};
