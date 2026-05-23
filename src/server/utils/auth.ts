import fetch from 'node-fetch';
import firebaseConfig from '../../../firebase-applet-config.json';

export async function verifyIdToken(idToken: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${firebaseConfig.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ idToken }),
      }
    );

    const data: any = await response.json();
    if (data.users && data.users.length > 0) {
      return data.users[0].localId;
    }
    return null;
  } catch (error) {
    console.error('Error verifying token:', error);
    return null;
  }
}
