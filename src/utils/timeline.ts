export function processTimeline(data: any) {
  return data;
}

export function buildSceneTimeline(scene: any) {
  console.log(`[Timeline] Building timeline for scene ${scene.scene_id}. Visuals count: ${scene.visuals?.length}`);
  const timeline = [];
  let currentTime = 0;
  
  const validVisuals = scene.visuals.filter((v: any) => {
    const isValid = v.status === 'completed' || v.status === 'degraded';
    if (!isValid) {
      console.log(`[Timeline] Visual ${v.visual_id} is NOT valid. Status: ${v.status}`);
    }
    return isValid;
  });
  
  console.log(`[Timeline] Valid visuals count: ${validVisuals.length}`);
  
  for (const visual of validVisuals) {
    const duration = visual.duration_target || 5;
    timeline.push({
      visual_id: visual.visual_id,
      start: currentTime,
      end: currentTime + duration
    });
    currentTime += duration;
  }
  
  console.log(`[Timeline] Generated timeline with ${timeline.length} segments.`);
  return timeline;
}
