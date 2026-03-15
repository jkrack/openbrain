import React from "react";
import { PersonProfile } from "../people";

export interface PersonPickerProps {
  people: PersonProfile[];
  onSelect: (person: PersonProfile) => void;
  onCancel: () => void;
}

export function PersonPicker({ people, onSelect, onCancel }: PersonPickerProps) {
  return (
    <div className="ca-person-picker">
      <div className="ca-person-picker-title">Who is this 1:1 with?</div>
      {people.length === 0 && (
        <div className="ca-person-picker-empty">
          No profiles found. Create profiles in OpenBrain/people/
        </div>
      )}
      {people.map((person) => (
        <button
          key={person.filePath}
          className="ca-person-option"
          onClick={() => onSelect(person)}
        >
          <span className="ca-person-name">{person.name}</span>
          <span className="ca-person-role">
            {person.role} — {person.domain}
          </span>
        </button>
      ))}
      <button className="ca-person-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
