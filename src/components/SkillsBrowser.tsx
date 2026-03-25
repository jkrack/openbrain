import { Skill } from "../skills";
import { ChatStateManager } from "../chatStateManager";

interface SkillsBrowserProps {
  skills: Skill[];
  chatState: ChatStateManager;
  onSkillRun: (skillId: string) => void;
}

export function SkillsBrowser({ skills, chatState: _chatState, onSkillRun }: SkillsBrowserProps) {
  return (
    <div className="ob-detached-skills-browser">
      {skills.length === 0 ? (
        <div className="ob-detached-placeholder">No skills found</div>
      ) : (
        skills.map((skill) => (
          <div key={skill.id} className="ob-detached-skill-card">
            <div className="ob-detached-skill-header">
              <span className="ob-detached-skill-name">{skill.name}</span>
              <span className="ob-detached-skill-input">{skill.input}</span>
            </div>
            <div className="ob-detached-skill-desc">{skill.description}</div>
            <div className="ob-detached-skill-footer">
              {skill.trigger && <span className="ob-detached-skill-trigger">Trigger: {skill.trigger}</span>}
              {skill.requiresPerson && <span className="ob-detached-skill-badge">Requires person</span>}
              <button
                className="ob-detached-skill-run"
                onClick={() => onSkillRun(skill.id)}
              >
                Run
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
