import type React from "react";
import { useEffect } from "react";

interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
	maxWidthClass?: string; // e.g., "max-w-4xl"
	disableEscapeClose?: boolean; // when true, Escape won't close the modal (child can handle it)
	actions?: React.ReactNode; // optional actions rendered in header before close
}

const Modal: React.FC<ModalProps> = ({
	isOpen,
	onClose,
	title,
	children,
	maxWidthClass = "max-w-2xl",
	disableEscapeClose,
	actions,
}) => {
	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !disableEscapeClose) {
				onClose();
			}
		};

		if (isOpen) {
			if (!disableEscapeClose) {
				document.addEventListener("keydown", handleEscape);
			}
			document.body.style.overflow = "hidden";
		}

		return () => {
			if (!disableEscapeClose) {
				document.removeEventListener("keydown", handleEscape);
			}
			document.body.style.overflow = "unset";
		};
	}, [isOpen, onClose, disableEscapeClose]);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-start sm:items-center justify-center z-50 p-0 sm:p-4"
			style={{
				paddingTop: "max(0px, env(safe-area-inset-top))",
				paddingBottom: "max(0px, env(safe-area-inset-bottom))",
			}}
			onClick={(e) => {
				// Click on backdrop (not modal content) closes
				if (e.target === e.currentTarget && !disableEscapeClose) {
					onClose();
				}
			}}
		>
			<div
				className={`bg-white dark:bg-gray-800 sm:rounded-lg shadow-2xl ${maxWidthClass} w-full max-h-full sm:max-h-[94dvh] overflow-y-auto transition-colors duration-200`}
				style={{
					touchAction: "pan-y",
					overscrollBehavior: "contain",
				}}
				role="dialog"
				aria-modal="true"
				aria-labelledby="modal-title"
			>
				<div
					className="sticky top-0 z-10 flex items-center justify-between gap-2 px-3 sm:px-6 pb-2 sm:pb-3 border-b border-gray-200 dark:border-gray-700 bg-white/95 dark:bg-gray-800/95 backdrop-blur supports-[backdrop-filter]:bg-white/75 supports-[backdrop-filter]:dark:bg-gray-800/75"
					style={{
						paddingTop: "max(0.75rem, max(0.75rem, env(safe-area-inset-top)))",
					}}
				>
					<h2
						id="modal-title"
						className="text-base font-semibold text-gray-900 dark:text-gray-100 min-w-0 flex-1 truncate"
						title={title}
					>
						{title}
					</h2>
					<div className="flex items-center gap-2 flex-shrink-0">
						{actions}
						<button
							type="button"
							onClick={onClose}
							className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded p-1 transition-colors duration-200 text-2xl leading-none w-8 h-8 flex items-center justify-center"
							aria-label="Close modal"
						>
							×
						</button>
					</div>
				</div>
				<div className="px-3 sm:px-6 pt-3 sm:pt-4 pb-4 sm:pb-6">
					{children}
				</div>
			</div>
		</div>
	);
};

export default Modal;
