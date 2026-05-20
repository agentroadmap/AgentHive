import type React from "react";
import { cn } from "../../lib/cn";

export interface SelectOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export interface SelectProps
	extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
	label?: string;
	error?: string;
	hint?: string;
	options: SelectOption[];
	placeholder?: string;
	selectSize?: "sm" | "md" | "lg";
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
	(
		{
			label,
			error,
			hint,
			options,
			placeholder,
			selectSize = "md",
			className,
			id,
			disabled,
			...props
		},
		ref,
	) => {
		const inputId = id ?? `select-${Math.random().toString(36).slice(2, 9)}`;
		const errorId = error ? `${inputId}-error` : undefined;
		const hintId = hint ? `${inputId}-hint` : undefined;

		const sizeClasses: Record<
			NonNullable<SelectProps["selectSize"]>,
			string
		> = {
			sm: "py-1.5 text-xs",
			md: "py-2 text-sm",
			lg: "py-2.5 text-base",
		};

		return (
			<div className="flex flex-col gap-1">
				{label && (
					<label
						htmlFor={inputId}
						className="text-sm font-medium text-[var(--color-text)]"
					>
						{label}
					</label>
				)}
				<div className="relative">
					<select
						ref={ref}
						id={inputId}
						disabled={disabled}
						aria-describedby={
							[errorId, hintId].filter(Boolean).join(" ") || undefined
						}
						aria-invalid={error ? true : undefined}
						className={cn(
							"w-full appearance-none rounded-[var(--radius-md)] border bg-[var(--color-surface)]",
							"px-3 pr-9 text-[var(--color-text)]",
							"transition-colors duration-[var(--transition-fast)]",
							"focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-0",
							error
								? "border-[var(--color-error)] focus-visible:outline-[var(--color-error)]"
								: "border-[var(--color-border)] hover:border-[var(--color-border-strong)]",
							disabled && "opacity-50 cursor-not-allowed",
							sizeClasses[selectSize],
							className,
						)}
						{...props}
					>
						{placeholder && (
							<option value="" disabled>
								{placeholder}
							</option>
						)}
						{options.map((opt) => (
							<option key={opt.value} value={opt.value} disabled={opt.disabled}>
								{opt.label}
							</option>
						))}
					</select>
					{/* Chevron icon */}
					<span
						className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
						aria-hidden="true"
					>
						{/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative chevron inside aria-hidden span — no title needed */}
						<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
							<path
								d="M2 4l4 4 4-4"
								stroke="currentColor"
								strokeWidth="1.5"
								fill="none"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</span>
				</div>
				{error && (
					<p
						id={errorId}
						role="alert"
						className="text-xs text-[var(--color-error)]"
					>
						{error}
					</p>
				)}
				{hint && !error && (
					<p id={hintId} className="text-xs text-[var(--color-text-muted)]">
						{hint}
					</p>
				)}
			</div>
		);
	},
);

Select.displayName = "Select";
