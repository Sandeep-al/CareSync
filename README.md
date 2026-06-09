# 🏥 CareSync - Hospital Management System

## 📝 Project Overview
CareSync is a lightweight, efficient Hospital Management System (HMS) designed to streamline daily hospital administration and clinical operations. It centralizes various hospital departments into a single relational platform to improve data flow and patient care. 

The application implements strict Role-Based Access Control (RBAC), providing customized, secure portals tailored to the specific permissions and workflows of different hospital staff.

## ✨ Key Features

* **Role-Based Dashboards:** Secure, dedicated web views for Admins, Doctors, Staff (Front Desk, Pharmacist, Billing), and Patients.
* **Patient & Admission Tracking:** Efficiently monitor patient registration details, illness severity, and hospital admissions.
* **Ward & Bed Management:** Track real-time availability and status of beds across different hospital wards (General, Private, ICU).
* **Clinical Operations:** Schedule doctor appointments, manage internal patient referrals, and generate medical prescriptions.
* **Automated Pharmacy Inventory:** Track medicine stock with automated database triggers that log pending orders when inventory drops below the reorder threshold.
* **Lab Tests & Requests:** Allow doctors to request lab tests for patients and update completion status and results.
* **Consolidated Billing:** Automatically calculate room charges, doctor fees, lab costs, and medicine costs to generate final bills and track payment status.

## 🛠️ Tech Stack

* **Backend:** Node.js, Express.js
* **Frontend UI:** EJS (Embedded JavaScript) templates, CSS
* **Database:** MySQL
* **Database Driver:** `mysql2` (utilized with Promise pool architecture)
* **Authentication:** Session-based authentication via `express-session`

## 🗄️ Database Architecture

The database architecture heavily utilizes Foreign Keys, Unique Keys, and explicit CHECK constraints to strictly enforce data integrity and business logic.

* **Core Tables:** The system is built on 16 interconnected tables: `admin`, `doctor`, `staff`, `patient`, `admission`, `appointment`, `medicine`, `reorder_log`, `bill`, `prescription`, `prescription_item`, `lab_test`, `test_request`, `ward`, `bed`, and `supplier`.
* **Automated SQL Triggers:**
    1. `After_Medicine_Update_Reorder`: Automatically monitors inventory. If a medicine's `stock_quantity` drops to or below its `reorder_level`, this trigger automatically inserts a pending restock request into the `reorder_log` table.
    2. `After_Admission_Insert_Bed_Status`: Automatically updates facility availability. Upon a new patient admission where a bed is allocated, this trigger instantly updates the respective bed's status to 'OCCUPIED' in the `bed` table.

## 👨‍💻 Developers

This is a group project developed by:
* **Sandeep Kumar**
* **Sourabh**
* **Anushka**
