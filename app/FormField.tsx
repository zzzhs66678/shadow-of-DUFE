import type { ReactNode } from "react";
import styles from "./form-field.module.css";

type FormFieldProps = {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  counter?: ReactNode;
  hint?: ReactNode;
  variant?: "body" | "display";
};

function joinClassNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function FormField({
  label,
  children,
  className,
  counter,
  hint,
  variant = "body",
}: FormFieldProps) {
  return (
    <label className={joinClassNames(styles.field, variant === "display" ? styles.display : undefined, className)}>
      <span className={styles.labelRow}>
        <span>{label}</span>
        {counter !== undefined && <small>{counter}</small>}
      </span>
      {children}
      {hint && <span className={styles.hint}>{hint}</span>}
    </label>
  );
}
