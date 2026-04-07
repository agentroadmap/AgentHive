export function formatLocalDateTime(
	date = new Date(),
	includeSeconds = false,
): string {
	const year = date.getFullYear();
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	const hour = `${date.getHours()}`.padStart(2, "0");
	const minute = `${date.getMinutes()}`.padStart(2, "0");

	if (!includeSeconds) {
		return `${year}-${month}-${day} ${hour}:${minute}`;
	}

	const second = `${date.getSeconds()}`.padStart(2, "0");
	return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
