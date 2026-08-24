import { Buffer } from 'buffer';
import fetch from 'node-fetch';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import firebaseConfig from '../../../firebase-applet-config.json';
import { requestContext } from '../utils/context.js';

let supabaseClient: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
    }
    supabaseClient = createClient(url, key);
  }
  return supabaseClient;
}

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId;
const apiKey = firebaseConfig.apiKey;

const DEV_TOKEN = '__dev__';

function withAuth(url: string, token: string): { url: string; headers: Record<string, string> } {
  if (token === DEV_TOKEN) {
    const sep = url.includes('?') ? '&' : '?';
    return { url: `${url}${sep}key=${apiKey}`, headers: {} };
  }
  return { url, headers: { 'Authorization': `Bearer ${token}` } };
}

export const fdb = {
  collection: (col: string) => ({
    doc: (id: string) => ({
       set: async (data: any) => { console.warn('Mock fdb.set called'); }
    }),
    get: async () => ({ empty: true })
  })
} as any;

export const storage = null;

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Convert JSON object to Firestore Document format fields
function jsonToFirestore(obj: any): any {
  if (obj === null) return { nullValue: null };
  if (typeof obj === 'boolean') return { booleanValue: obj };
  if (typeof obj === 'number') {
    if (Number.isInteger(obj)) return { integerValue: obj };
    return { doubleValue: obj };
  }
  if (typeof obj === 'string') return { stringValue: obj };
  if (Array.isArray(obj)) return { arrayValue: { values: obj.map(jsonToFirestore) } };
  if (typeof obj === 'object') {
    const fields: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) {
         fields[k] = jsonToFirestore(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

function firestoreToJson(val: any): any {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return val.stringValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(firestoreToJson);
  if ('mapValue' in val) {
    const obj: any = {};
    const fields = val.mapValue.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      obj[k] = firestoreToJson(v);
    }
    return obj;
  }
  return null;
}

export const FirestoreService = {
  async saveProject(project: any) {
    const id = project.project_id || project.id;
    if (!id) {
       console.warn('[FirestoreService] Cannot save project: No ID found', project);
       return;
    }
    const token = requestContext.getStore()?.token;
    if (!token) {
        console.warn('Cannot write project without auth token context', id);
        return;
    }

    const docPath = `projects/${id}`;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/${docPath}`;
    
    try {
      const dataToSave = {
        ...project,
        updatedAt: new Date().toISOString()
      };
      
      const fields = jsonToFirestore(dataToSave).mapValue.fields;
      const updateMaskParams = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      const { url: authUrl, headers: authHeaders } = withAuth(`${url}?${updateMaskParams}`, token);
      console.log('[Firestore] PATCH URL:', authUrl.replace(apiKey, apiKey.slice(0, 8) + '...'));

      const res = await fetch(authUrl, {
         method: 'PATCH',
         headers: { ...authHeaders, 'Content-Type': 'application/json' },
         body: JSON.stringify({ name: `projects/${projectId}/databases/${databaseId}/documents/${docPath}`, fields })
      });

      if (!res.ok) {
         const errorText = await res.text();
         throw new Error(`REST Error ${res.status}: ${errorText}`);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, docPath);
    }
  },

  async deleteProject(id: string) {
    const token = requestContext.getStore()?.token;
    if (!token) return;

    const docPath = `projects/${id}`;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/${docPath}`;
    
    try {
      const { url: authUrl, headers: authHeaders } = withAuth(url, token);
      const res = await fetch(authUrl, { method: 'DELETE', headers: authHeaders });
      if (!res.ok) {
         throw new Error(`REST Error ${res.status}: ${await res.text()}`);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, docPath);
    }
  },

  async getProjects(userId: string) {
    const path = 'projects';
    const token = requestContext.getStore()?.token;
    if (!token) return [];

    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents:runQuery`;
    try {
      const { url: authUrl, headers: authHeaders } = withAuth(url, token);
      const res = await fetch(authUrl, {
         method: 'POST',
         headers: { ...authHeaders, 'Content-Type': 'application/json' },
         body: JSON.stringify({
           structuredQuery: {
             from: [{ collectionId: 'projects' }],
             // Always filtered by owner, dev-user included.
             //
             // dev-user used to be exempt, which made it a superuser for READING and a
             // nobody for WRITING: the dashboard listed every cloud project in the
             // database, and the mutation routes then refused the ones it did not own.
             // Selecting a dozen and hitting delete returned a row of 403s — the local
             // half went, the cloud half did not, and the button looked broken.
             //
             // The exemption cannot be paid for on the write side without handing a
             // local session the power to delete other accounts' cloud records, so the
             // read side is what gives way. Nothing listed is now unmodifiable.
             where: {
               fieldFilter: {
                 field: { fieldPath: 'userId' },
                 op: 'EQUAL',
                 value: { stringValue: userId }
               }
             }
           }
         })
      });
      if (!res.ok) throw new Error(await res.text());
      const data: any = await res.json();
      
      return data.filter((item: any) => item.document).map((item: any) => {
         return firestoreToJson({ mapValue: item.document });
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  },

  async getProject(projectIdStr: string) {
    const docPath = `projects/${projectIdStr}`;
    const token = requestContext.getStore()?.token;
    if (!token) return null;

    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/${docPath}`;
    try {
      const { url: authUrl, headers: authHeaders } = withAuth(url, token);
      const res = await fetch(authUrl, { headers: authHeaders });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(await res.text());
      const data: any = await res.json();
      return firestoreToJson({ mapValue: data });
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, docPath);
    }
  },

  async uploadAsset(projectIdStr: string, fileName: string, data: any, contentType: string) {
    const filePath = `projects/${projectIdStr}/${fileName}`;

    let uploadData: Buffer;
    if (typeof data === 'string') {
      const base64Data = data.includes('base64,') ? data.split('base64,')[1] : data;
      uploadData = Buffer.from(base64Data, 'base64');
    } else if (Buffer.isBuffer(data)) {
      uploadData = data;
    } else {
      uploadData = Buffer.from(data);
    }

    console.log(`[Storage] Uploading to Supabase: ${filePath}`);

    const { error } = await getSupabase()
      .storage
      .from('aivideogen')
      .upload(filePath, uploadData, { contentType, upsert: true });

    if (error) {
      console.error(`[Storage] Supabase upload failed for ${filePath}:`, error.message);
      throw new Error(`Storage upload failed: ${error.message}`);
    }

    const { data: urlData } = getSupabase()
      .storage
      .from('aivideogen')
      .getPublicUrl(filePath);

    console.log(`[Storage] Upload successful: ${urlData.publicUrl}`);
    return urlData.publicUrl;
  },

  async saveDocument(collection: string, id: string, data: any) {
    const token = requestContext.getStore()?.token;
    if (!token) {
      console.warn(`[FirestoreService] Cannot save ${collection}/${id}: No auth token`);
      return;
    }
    const docPath = `${collection}/${id}`;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/${docPath}`;
    try {
      const dataToSave = { ...data, updatedAt: new Date().toISOString() };
      const fields = jsonToFirestore(dataToSave).mapValue.fields;
      const updateMaskParams = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      const { url: authUrl, headers: authHeaders } = withAuth(`${url}?${updateMaskParams}`, token);
      const res = await fetch(authUrl, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `projects/${projectId}/databases/${databaseId}/documents/${docPath}`, fields })
      });
      if (!res.ok) throw new Error(`REST Error ${res.status}: ${await res.text()}`);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, docPath);
    }
  },

  async getDocument(collection: string, id: string) {
    const token = requestContext.getStore()?.token;
    if (!token) return null;
    const docPath = `${collection}/${id}`;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/${docPath}`;
    try {
      const { url: authUrl, headers: authHeaders } = withAuth(url, token);
      const res = await fetch(authUrl, { headers: authHeaders });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(await res.text());
      const data: any = await res.json();
      return firestoreToJson({ mapValue: data });
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, docPath);
    }
  },

  async listDocuments(collection: string, userId: string) {
    const token = requestContext.getStore()?.token;
    if (!token) return [];
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents:runQuery`;
    try {
      const { url: authUrl, headers: authHeaders } = withAuth(url, token);
      const res = await fetch(authUrl, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: collection }],
            ...(userId !== 'dev-user' && {
              where: {
                fieldFilter: {
                  field: { fieldPath: 'userId' },
                  op: 'EQUAL',
                  value: { stringValue: userId }
                }
              }
            })
          }
        })
      });
      if (!res.ok) throw new Error(await res.text());
      const data: any = await res.json();
      return data.filter((item: any) => item.document).map((item: any) =>
        firestoreToJson({ mapValue: item.document })
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, collection);
    }
  },

  async deleteDocument(collection: string, id: string) {
    const token = requestContext.getStore()?.token;
    if (!token) return;
    const docPath = `${collection}/${id}`;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/${docPath}`;
    try {
      const { url: authUrl, headers: authHeaders } = withAuth(url, token);
      const res = await fetch(authUrl, { method: 'DELETE', headers: authHeaders });
      if (!res.ok) throw new Error(`REST Error ${res.status}: ${await res.text()}`);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, docPath);
    }
  },

  async deleteAssetByUrl(urlStr: string) {
    try {
      // Supabase public URL format:
      // https://<project>.supabase.co/storage/v1/object/public/aivideogen/<path>
      const url = new URL(urlStr);
      const marker = '/object/public/aivideogen/';
      const idx = url.pathname.indexOf(marker);
      if (idx === -1) {
        console.warn(`[Storage] Could not extract path from URL: ${urlStr}`);
        return;
      }
      const filePath = decodeURIComponent(url.pathname.slice(idx + marker.length));

      const { error } = await getSupabase()
        .storage
        .from('aivideogen')
        .remove([filePath]);

      if (error) {
        console.warn(`[Storage] Supabase delete failed: ${error.message}`);
      }
    } catch (error) {
      console.error('[Storage] Storage delete error:', error);
    }
  }
};

