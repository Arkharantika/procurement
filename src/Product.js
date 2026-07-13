import { DataTypes } from "sequelize";
import { sequelize } from "../database/koneksi_database.js";

export const Product = sequelize.define(
  "Product",
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.TEXT, allowNull: false },
    brand: DataTypes.STRING,
    category: DataTypes.STRING,
    price: DataTypes.DECIMAL(15, 2),
    unit: { type: DataTypes.STRING, defaultValue: "pcs" },
  },
  {
    tableName: "products",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  }
);
