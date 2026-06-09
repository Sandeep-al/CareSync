USE caresync;

DELIMITER //

CREATE TRIGGER After_Medicine_Update_Reorder
AFTER UPDATE ON medicine
FOR EACH ROW
BEGIN
    IF NEW.stock_quantity <= NEW.reorder_level
       AND OLD.stock_quantity > OLD.reorder_level THEN
        INSERT INTO reorder_log (medicine_id, log_date, quantity_needed, status)
        VALUES (NEW.medicine_id, CURDATE(), 50, 'PENDING');
    END IF;
END //

CREATE TRIGGER After_Admission_Insert_Bed_Status
AFTER INSERT ON admission
FOR EACH ROW
BEGIN
    IF NEW.bed_id IS NOT NULL THEN
        UPDATE bed
        SET status = 'OCCUPIED'
        WHERE bed_id = NEW.bed_id;
    END IF;
END //

DELIMITER ;


DELIMITER //

CREATE TRIGGER After_Admission_Update_Free_Bed
AFTER UPDATE ON admission
FOR EACH ROW
BEGIN
    -- Check karta hai ki kya admission status abhi-abhi 'DISCHARGED' hua hai
    IF NEW.status = 'DISCHARGED' AND OLD.status != 'DISCHARGED' THEN
        -- Bed ko wapas AVAILABLE kar do
        UPDATE bed
        SET status = 'AVAILABLE'
        WHERE bed_id = NEW.bed_id;
    END IF;
END //

DELIMITER ;