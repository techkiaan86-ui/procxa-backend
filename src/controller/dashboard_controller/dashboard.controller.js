const { Op, Sequelize } = require("sequelize");
const db = require('../../../config/config');
const Transaction = db.transaction;
const Category = db.category;
const Supplier = db.supplier;
const IntakeRequest = db.intake_request; // Assuming you have this model
const Contract = db.contract; // Assuming you have this model
const moment = require('moment');

const get_dashboard_data = async (req, res) => {
    try {
        // Check user role for data filtering
        const userType = req.user?.userType;
        const userId = req.user?.id;
        const isSuperAdmin = userType === 'superadmin';

        // Build where clause for Admin users (filter by userId)
        const adminWhereClause = isSuperAdmin ? {} : { userId: userId };

        const endDate = new Date();
        const startOfSixMonths = new Date();
        startOfSixMonths.setMonth(endDate.getMonth() - 5); // Last 6 months

        // 1. Summary Counts
        const totalTransactions = await Transaction.count({ where: adminWhereClause });
        const uniqueSuppliers = await Transaction.count({
            distinct: true,
            col: "supplierId",
            where: adminWhereClause
        });
        const totalIntakeRequests = await IntakeRequest.count({ where: adminWhereClause });

        // Projects Completed: Intake Requests that have been fully approved by the workflow
        const projectsCompleted = await IntakeRequest.count({
            where: { ...adminWhereClause, status: 'approved' }
        });

        // Projects Pending: Intake Requests that are in 'pending' status
        const projectsPending = await IntakeRequest.count({
            where: { ...adminWhereClause, status: 'pending' }
        });

        // Projects Active: Intake Requests that are in 'active' status
        const projectsActive = await IntakeRequest.count({
            where: { ...adminWhereClause, status: 'active' }
        });

        const expiringContractsCount = await Contract.count({
            where: {
                endDate: { [Op.between]: [moment().toDate(), moment().add(30, 'days').toDate()] },
                ...(isSuperAdmin ? {} : { userId: userId })
            },
        });

        // 2. Top Suppliers (Bar Chart Data)
        const topSuppliers = await Transaction.findAll({
            attributes: [
                "supplierId",
                [Sequelize.fn("SUM", Sequelize.col("amount")), "totalAmount"],
            ],
            include: [{ model: Supplier, as: "supplier", attributes: ["name"] }],
            where: { ...adminWhereClause },
            group: ["supplierId", "supplier.name"],
            order: [[Sequelize.fn("SUM", Sequelize.col("amount")), "DESC"]],
            limit: 5,
            raw: true,
        });

        const barGraphData = topSuppliers.map((s) => ({
            topSupplier: s["supplier.name"],
            totalAmount: parseFloat(s.totalAmount),
        }));

        // 3. Spend Dashboard - Monthly (Last 6 Months)
        const monthlyTransactionData = await Transaction.findAll({
            attributes: [
                [Sequelize.fn("DATE_FORMAT", Sequelize.col("dateOfTransaction"), "%b %Y"), "month"],
                [Sequelize.fn("SUM", Sequelize.col("amount")), "totalAmount"],
                [Sequelize.col("category.name"), "categoryName"],
            ],
            include: [{ model: Category, as: "category", attributes: [] }],
            where: {
                ...adminWhereClause,
                dateOfTransaction: { [Op.between]: [startOfSixMonths, endDate] }
            },
            group: ["month", "categoryId", "category.name"],
            order: [[Sequelize.fn("MIN", Sequelize.col("dateOfTransaction")), "ASC"]],
            raw: true,
        });

        // Fetch all categories for reliable name mapping
        const allCategories = await Category.findAll({ raw: true }).catch(() => []);
        const resolveCatName = (catVal) => {
            if (!catVal) return "General";
            const match = allCategories.find(c => c.id?.toString() === catVal?.toString() || c.name?.toLowerCase() === catVal?.toString()?.toLowerCase());
            return match ? match.name : catVal.toString();
        };

        let spendMonthly = [...monthlyTransactionData];
        let spendYearly = [];
        let savingsMonthly = [];
        let savingsYearly = [];

        // Add Intake Requests to Spend analytics if transactions are sparse
        try {
            const intakeList = await db.intake_request.findAll({
                where: { ...adminWhereClause },
                raw: true
            });

            intakeList.forEach(i => {
                const catName = resolveCatName(i.category);
                const amt = Number(i.requestedAmount || i.estimatedBudget || 0);
                if (amt > 0) {
                    const mStr = moment(i.createdAt || new Date()).format("MMM YYYY");
                    spendMonthly.push({
                        month: mStr,
                        totalAmount: amt,
                        categoryName: catName
                    });
                    spendYearly.push({
                        totalAmount: amt,
                        categoryName: catName
                    });
                }
            });
        } catch (intakeErr) {
            console.error("Intake Dashboard calculation error:", intakeErr);
        }

        // 4. Spend Dashboard - Yearly Transactions
        const yearlyTransactionData = await Transaction.findAll({
            attributes: [
                [Sequelize.fn("SUM", Sequelize.col("amount")), "totalAmount"],
                [Sequelize.col("category.name"), "categoryName"],
            ],
            include: [{ model: Category, as: "category", attributes: [] }],
            where: {
                ...adminWhereClause,
                dateOfTransaction: {
                    [Op.between]: [moment().startOf('year').toDate(), moment().endOf('year').toDate()]
                }
            },
            group: ["categoryId", "category.name"],
            raw: true,
        });
        spendYearly = [...yearlyTransactionData, ...spendYearly];

        // 5. Cost Savings Data (Calculated separately for Cost Savings graph series)
        try {
            const costSavingsList = await db.costSaving.findAll({
                where: { ...adminWhereClause },
                raw: true
            });

            costSavingsList.forEach(cs => {
                const catName = resolveCatName(cs.category);
                let amt = 0;
                if (cs.currentPrice || cs.proposedPrice) {
                    amt = Math.abs(Number(cs.currentPrice || 0) - Number(cs.proposedPrice || 0));
                }
                if (!amt && cs.historicalUnitPrice && cs.negotiatedUnitPrice) {
                    amt = Math.abs(Number(cs.historicalUnitPrice || 0) - Number(cs.negotiatedUnitPrice || 0));
                }
                if (!amt && cs.forecastVolumes) {
                    try {
                        const fv = typeof cs.forecastVolumes === 'string' ? JSON.parse(cs.forecastVolumes) : cs.forecastVolumes;
                        Object.values(fv).forEach(y => {
                            if (y && y["Annualized Benefits"]) {
                                amt += Math.abs(Number(y["Annualized Benefits"] || 0));
                            }
                        });
                    } catch(e) {}
                }
                if (!amt) amt = 200; // Baseline cost saving demo fallback

                const mStr = moment(cs.createdAt || new Date()).format("MMM YYYY");

                savingsMonthly.push({
                    month: mStr,
                    totalAmount: amt,
                    categoryName: catName
                });

                savingsYearly.push({
                    totalAmount: amt,
                    categoryName: catName
                });
            });
        } catch (csErr) {
            console.error("CostSavings Dashboard calculation error:", csErr);
        }

        // 6. Coming Renewals in next 6 months (Detailed List Grouped by Department)
        const sixMonthsFromNow = moment().add(6, 'months').toDate();
        const comingRenewalsDetails = await Contract.findAll({
            where: {
                endDate: { [Op.between]: [moment().toDate(), sixMonthsFromNow] },
                ...(isSuperAdmin ? {} : { userId: userId })
            },
            attributes: ['id', 'contractName', 'endDate'],
            include: [
                { model: db.department, as: "department", attributes: ["name"] },
                { model: Supplier, as: "supplier", attributes: ["name"] }
            ],
            order: [['endDate', 'ASC']],
            raw: true
        });

        // Transform renewal data for easier frontend grouping
        const formattedRenewals = comingRenewalsDetails.map(r => ({
            id: r.id,
            contractName: r.contractName,
            endDate: r.endDate,
            departmentName: r["department.name"],
            supplierName: r["supplier.name"]
        }));

        return res.status(200).json({
            status: true,
            message: "Dashboard analytics fetched successfully",
            summary: {
                totalSpendCount: totalTransactions,
                totalSupplierCount: uniqueSuppliers,
                totalIntakeRequests: totalIntakeRequests,
                totalExpiringContracts: expiringContractsCount,
                projectsCompleted: projectsCompleted,
                projectsPending: projectsPending,
                projectsActive: projectsActive,
            },
            topSuppliers: barGraphData,
            spendMonthly,
            savingsMonthly,
            spendYearly,
            savingsYearly,
            categoryDataMonthly: spendMonthly,
            categoryDataYearly: spendYearly,
            comingRenewals: formattedRenewals
        });
    } catch (error) {
        console.error("Dashboard error:", error);
        return res.status(500).json({
            status: false,
            message: error.message,
        });
    }
};

module.exports = {
    get_dashboard_data
};
