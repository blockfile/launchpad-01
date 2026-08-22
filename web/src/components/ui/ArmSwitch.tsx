interface ArmSwitchProps {
  armed: boolean;
  onChange: (armed: boolean) => void;
  disabled?: boolean;
}

export function ArmSwitch({ armed, onChange, disabled }: ArmSwitchProps) {
  return (
    <label className={`switch ${armed ? "armed" : ""}`}>
      <input
        type="checkbox"
        role="checkbox"
        aria-label="Arm"
        checked={armed}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      Arm
    </label>
  );
}
