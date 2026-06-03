import type React from "react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn";

export interface CheckboxProps
	extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
	label?: React.ReactNode;
	indeterminate?: boolean;
	error?: string;
	hint?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
	(
		{
			label,
			indeterminate = false,
			error,
			hint,
			className,
			id,
			disabled,
			...props
		},
		ref,
	) => {
		const internalRef = useRef<HTMLInputElement | null>(null);
		const inputId = id ?? `checkbox-${Math.random().toString(36).slice(2, 9)}`;
		const errorId = error ? `${inputId}-error` : undefined;
		const hintId = hint ? `${inputId}-hint` : undefined;

		// Sync ref and indeterminate state
		useEffect(() => {
			if (internalRef.current) {
				internalRef.current.indeterminate = indeterminate;
			}
		}, [indeterminate]);

		const setRef = (el: HTMLInputElement | null) => {
			internalRef.current = el;
			if (typeof ref === "function") ref(el);
			else if (ref)
				(ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
		};

		return (
			<div className="flex flex-col gap-1">
				<label
					htmlFor={inputId}
					className={cn(
						"inline-flex items-start gap-2.5 cursor-pointer",
						disabled && "cursor-not-allowed opacity-50",
					)}
				>
					<input
						ref={setRef}
						type="checkbox"
						id={inputId}
						disabled={disabled}
						aria-describedby={
							[errorId, hintId].filter(Boolean).join(" ") || undefined
						}
						aria-invalid={error ? true : undefined}
						className={cn(
							"mt-0.5 h-4 w-4 shrink-0 rounded-[var(--radius-sm)]",
							"border border-[var(--color-border)] bg-[var(--color-surface)]",
							"accent-[var(--color-primary)]",
							"focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-2",
							"transition-colors duration-[var(--transition-fast)]",
							error && "border-[var(--color-error)]",
							className,
						)}
						{...props}
					/>
					{label && (
						<span className="text-sm text-[var(--color-text)] leading-5">
							{label}
						</span>
					)}
				</label>
				{error && (
					<p
						id={errorId}
						role="alert"
						className="text-xs text-[var(--color-error)] ml-6"
					>
						{error}
					</p>
				)}
				{hint && !error && (
					<p
						id={hintId}
						className="text-xs text-[var(--color-text-muted)] ml-6"
					>
						{hint}
					</p>
				)}
			</div>
		);
	},
);

Checkbox.displayName = "Checkbox";
