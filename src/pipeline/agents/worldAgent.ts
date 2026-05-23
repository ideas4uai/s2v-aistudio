import { Project } from "../../models/project.js";
import { AIService } from "../../services/aiService.js";

export class WorldAgent {
  static async analyzeWorld(project: Project, script: string): Promise<any> {
    console.log(`[WorldAgent] Analyzing script for characters, locations, and key objects...`);
    
    const prompt = `You are a professional Story Producer and World Builder. 
Analyze the following video script and extract all unique Characters, Locations, and Key Objects.

### ENTITY GUIDELINES:
1. **Characters**: Identify any named or significant person/entity (e.g., "The Narrator", "John", "A busy shopper").
2. **Locations**: Identify specific settings (e.g., "A futuristic laboratory", "Cozy coffee shop").
3. **Key Objects**: Identify props or items mentioned that are central to the visual story (e.g., "A glowing crystal", "Antique pocket watch").

### EXTRACTION RULES:
- For each entity, provide:
  - Name: A concise identifier.
  - Description: 1 sentence about their role.
  - Prompt: A specific visual description (15-25 words) for AI image generation. Include physical traits, clothing, or atmosphere. Avoid vague terms.
- If no entities of a certain type are found, return an empty array for that key.

### SCRIPT:
"${script}"

### OUTPUT FORMAT:
Output ONLY valid JSON. 
Example Format:
{
  "characters": [ { "name": "...", "description": "...", "prompt": "..." } ],
  "locations": [ { "name": "...", "description": "...", "prompt": "..." } ],
  "objects": [ { "name": "...", "description": "...", "prompt": "..." } ]
}
`;

    try {
      const text = await AIService.generateText(prompt, { 
        task: 'world'
      });
      
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        let cleanText = text.trim();
        const firstBrace = cleanText.indexOf('{');
        const lastBrace = cleanText.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1) {
          cleanText = cleanText.substring(firstBrace, lastBrace + 1);
          parsed = JSON.parse(cleanText);
        } else {
          throw new Error('No valid JSON found in AI response');
        }
      }
      return parsed;
    } catch (e) {
      console.error(`[WorldAgent] Analysis failed:`, e);
      return { characters: [], locations: [], objects: [] };
    }
  }
}
