-- The states are the ones the control plane sets (architecture section 9.3). A Dot was never DISABLED and a computer
-- never IDLE: no version wrote either (a computer that sleeps is STOPPED, its Dot IDLE), so no row holds them, and the
-- checks name only what can be stored.
ALTER TABLE dots DROP CONSTRAINT dots_status_check;
ALTER TABLE dots ADD CONSTRAINT dots_status_check CHECK (status IN ('CREATING', 'READY', 'IDLE', 'RUNNING', 'WAITING_APPROVAL', 'ERROR'));
ALTER TABLE computers DROP CONSTRAINT computers_state_check;
ALTER TABLE computers ADD CONSTRAINT computers_state_check CHECK (state IN ('PROVISIONING', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR', 'DELETING'));
