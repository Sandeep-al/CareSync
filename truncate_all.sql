-- 1. Foreign Key checking band karo taaki errors na aayein
SET FOREIGN_KEY_CHECKS = 0;

-- 2. Saari tables ko ekdum naya jaisa bana do (Data clear + Auto Increment Reset)
TRUNCATE TABLE `prescription_item`;
TRUNCATE TABLE `prescription`;
TRUNCATE TABLE `test_request`;
TRUNCATE TABLE `bill`;
TRUNCATE TABLE `reorder_log`;
TRUNCATE TABLE `referral`;
TRUNCATE TABLE `appointment`;
TRUNCATE TABLE `admission`;
TRUNCATE TABLE `patient`;
TRUNCATE TABLE `doctor`;
TRUNCATE TABLE `bed`;
TRUNCATE TABLE `ward`;
TRUNCATE TABLE `medicine`;
TRUNCATE TABLE `supplier`;
TRUNCATE TABLE `lab_test`;
TRUNCATE TABLE `staff`;
TRUNCATE TABLE `admin`;

-- 3. Foreign Key checking wapas ON kar do (Very Important)
SET FOREIGN_KEY_CHECKS = 1;