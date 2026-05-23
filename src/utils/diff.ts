export function getDiff(oldObj: any, newObj: any) {
  return {};
}

export function getScenesToRender(oldScenes: any[], newScenes: any[]) {
  return newScenes.map(s => s.scene_id);
}
