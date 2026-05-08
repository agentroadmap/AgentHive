/**
 * Agency-specific errors — P921 and future invariants.
 */

/**
 * Thrown when selfRegisterAgency detects an existing active session for the same agency_id.
 * The database constraint idx_agency_session_one_active rejects the duplicate INSERT;
 * the application catches the unique violation and throws this typed error.
 *
 * P921 AC-6: fields agency_id (required), existing_session_id?, existing_liaison_pid?, existing_liaison_host?.
 */
export class AgencyAlreadyActive extends Error {
	public readonly agency_id: string;
	public readonly existing_session_id?: string;
	public readonly existing_liaison_pid?: number;
	public readonly existing_liaison_host?: string;

	constructor(
		agency_id: string,
		existing_session_id?: string,
		existing_liaison_pid?: number,
		existing_liaison_host?: string,
	) {
		super(
			`Agency ${agency_id} already has an active liaison session: ` +
				`session=${existing_session_id} pid=${existing_liaison_pid} host=${existing_liaison_host}`,
		);
		this.name = "AgencyAlreadyActive";
		this.agency_id = agency_id;
		this.existing_session_id = existing_session_id;
		this.existing_liaison_pid = existing_liaison_pid;
		this.existing_liaison_host = existing_liaison_host;
		Object.setPrototypeOf(this, AgencyAlreadyActive.prototype);
	}
}
