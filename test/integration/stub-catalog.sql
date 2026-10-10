-- A stand-in for the SSISDB catalog schema, for checking SQL syntax, parameter
-- binding and driver behaviour on any SQL Server (the real catalog only exists
-- on SQL Server for Windows). Procedure signatures follow the documented ones;
-- the bodies only record what they were called with.
CREATE SCHEMA catalog;
GO
CREATE TABLE catalog.catalog_properties (property_name nvarchar(256), property_value nvarchar(256));
CREATE TABLE catalog.folders (folder_id bigint IDENTITY PRIMARY KEY, name nvarchar(128), description nvarchar(1024));
CREATE TABLE catalog.projects (project_id bigint IDENTITY PRIMARY KEY, folder_id bigint, name nvarchar(128), last_deployed_time datetimeoffset, deployed_by_name nvarchar(128), object_version_lsn bigint);
CREATE TABLE catalog.packages (package_id bigint IDENTITY PRIMARY KEY, project_id bigint, name nvarchar(260), entry_point bit, description nvarchar(1024));
CREATE TABLE catalog.object_parameters (parameter_id bigint IDENTITY PRIMARY KEY, project_id bigint, object_type smallint, object_name nvarchar(260), parameter_name nvarchar(128), data_type nvarchar(128), required bit, sensitive bit, value_type char(1), default_value sql_variant, design_default_value sql_variant, referenced_variable_name nvarchar(128));
CREATE TABLE catalog.environments (environment_id bigint IDENTITY PRIMARY KEY, folder_id bigint, name nvarchar(128), description nvarchar(1024));
CREATE TABLE catalog.environment_variables (variable_id bigint IDENTITY PRIMARY KEY, environment_id bigint, name nvarchar(128), type nvarchar(128), sensitive bit, value sql_variant);
CREATE TABLE catalog.environment_references (reference_id bigint IDENTITY PRIMARY KEY, project_id bigint, reference_type char(1), environment_folder_name nvarchar(128), environment_name nvarchar(128));
CREATE TABLE catalog.executions (execution_id bigint IDENTITY(100,1) PRIMARY KEY, folder_name nvarchar(128), project_name nvarchar(128), package_name nvarchar(260), reference_id bigint, status int, start_time datetimeoffset, end_time datetimeoffset, created_time datetimeoffset DEFAULT SYSDATETIMEOFFSET(), executed_as_name nvarchar(128), environment_name nvarchar(128), use32bitruntime bit, server_name nvarchar(128));
CREATE TABLE catalog.event_messages (event_message_id bigint IDENTITY PRIMARY KEY, operation_id bigint, message_time datetimeoffset, message_type smallint, message_source_name nvarchar(4000), package_name nvarchar(260), execution_path nvarchar(max), message nvarchar(max));
CREATE TABLE catalog.operations (operation_id bigint PRIMARY KEY, status int);
CREATE TABLE catalog.operation_messages (operation_message_id bigint IDENTITY PRIMARY KEY, operation_id bigint, message_time datetimeoffset, message_type smallint, message nvarchar(max));
CREATE TABLE catalog.executables (executable_id bigint, execution_id bigint, executable_name nvarchar(4000), package_name nvarchar(260));
CREATE TABLE catalog.executable_statistics (statistics_id bigint IDENTITY PRIMARY KEY, execution_id bigint, executable_id bigint, execution_path nvarchar(max), start_time datetimeoffset, execution_duration int, execution_result smallint);
CREATE TABLE catalog.execution_parameter_values (execution_parameter_id bigint IDENTITY PRIMARY KEY, execution_id bigint, object_type smallint, parameter_name nvarchar(128), parameter_value sql_variant, sensitive bit DEFAULT 0, value_set bit DEFAULT 1, base_type nvarchar(128));
CREATE TABLE catalog.stub_calls (id int IDENTITY PRIMARY KEY, name nvarchar(128), detail nvarchar(max));
GO
CREATE PROCEDURE catalog.create_execution @folder_name nvarchar(128), @project_name nvarchar(128), @package_name nvarchar(260), @reference_id bigint = NULL, @use32bitruntime bit = 0, @runinscaleout bit = NULL, @useanyworker bit = NULL, @execution_id bigint OUTPUT AS
BEGIN
	INSERT catalog.executions (folder_name, project_name, package_name, reference_id, status, executed_as_name, use32bitruntime, server_name, environment_name)
	VALUES (@folder_name, @project_name, @package_name, @reference_id, 1, SUSER_SNAME(), @use32bitruntime, @@SERVERNAME, (SELECT environment_name FROM catalog.environment_references WHERE reference_id = @reference_id));
	SET @execution_id = SCOPE_IDENTITY();
END
GO
CREATE PROCEDURE catalog.set_execution_parameter_value @execution_id bigint, @object_type smallint, @parameter_name nvarchar(128), @parameter_value sql_variant AS
	INSERT catalog.execution_parameter_values (execution_id, object_type, parameter_name, parameter_value, base_type)
	VALUES (@execution_id, @object_type, @parameter_name, @parameter_value, CAST(SQL_VARIANT_PROPERTY(@parameter_value, 'BaseType') AS nvarchar(128)));
GO
CREATE PROCEDURE catalog.start_execution @execution_id bigint, @retry_count int = 0 AS
	UPDATE catalog.executions SET status = 7, start_time = SYSDATETIMEOFFSET(), end_time = DATEADD(second, 5, SYSDATETIMEOFFSET()) WHERE execution_id = @execution_id;
GO
CREATE PROCEDURE catalog.stop_operation @operation_id bigint AS
	UPDATE catalog.executions SET status = 3 WHERE execution_id = @operation_id;
GO
CREATE PROCEDURE catalog.create_folder @folder_name nvarchar(128), @folder_id bigint = NULL OUTPUT AS
BEGIN
	INSERT catalog.folders (name) VALUES (@folder_name);
	SET @folder_id = SCOPE_IDENTITY();
END
GO
CREATE PROCEDURE catalog.deploy_project @folder_name nvarchar(128), @project_name nvarchar(128), @project_stream varbinary(max), @operation_id bigint OUTPUT AS
BEGIN
	SET @operation_id = 9000 + (SELECT COUNT(*) FROM catalog.operations);
	INSERT catalog.operations (operation_id, status) VALUES (@operation_id, 7);
	INSERT catalog.stub_calls (name, detail) VALUES ('deploy_project', CONCAT(@folder_name, '/', @project_name, ' bytes=', DATALENGTH(@project_stream), ' zip=', CASE WHEN SUBSTRING(@project_stream, 1, 2) = 0x504B THEN 'yes' ELSE 'no' END));
END
GO
CREATE PROCEDURE catalog.set_object_parameter_value @object_type smallint, @folder_name nvarchar(128), @project_name nvarchar(128), @parameter_name nvarchar(128), @parameter_value sql_variant, @object_name nvarchar(260) = NULL, @value_type char(1) = 'V' AS
	INSERT catalog.stub_calls (name, detail) VALUES ('set_object_parameter_value', CONCAT(@object_type, ' ', @folder_name, '/', @project_name, '/', @object_name, ' ', @parameter_name, '=', CAST(@parameter_value AS nvarchar(4000)), ' ', @value_type, ' ', CAST(SQL_VARIANT_PROPERTY(@parameter_value, 'BaseType') AS nvarchar(128))));
GO
CREATE PROCEDURE catalog.set_environment_variable_value @folder_name nvarchar(128), @environment_name nvarchar(128), @variable_name nvarchar(128), @value sql_variant AS
	INSERT catalog.stub_calls (name, detail) VALUES ('set_environment_variable_value', CONCAT(@folder_name, '/', @environment_name, '/', @variable_name, '=', CAST(@value AS nvarchar(4000)), ' ', CAST(SQL_VARIANT_PROPERTY(@value, 'BaseType') AS nvarchar(128))));
GO
INSERT catalog.catalog_properties VALUES ('SCHEMA_VERSION', '8');
INSERT catalog.folders (name, description) VALUES ('ETL', 'Nightly loads');
INSERT catalog.projects (folder_id, name, last_deployed_time, deployed_by_name, object_version_lsn) VALUES (1, 'Sales', SYSDATETIMEOFFSET(), 'CORP\deployer', 3);
INSERT catalog.packages (project_id, name, entry_point) VALUES (1, 'LoadSales.dtsx', 1), (1, 'MergeSales.dtsx', 1);
INSERT catalog.object_parameters (project_id, object_type, object_name, parameter_name, data_type, required, sensitive, value_type, default_value) VALUES (1, 20, 'Sales', 'Environment', 'String', 0, 0, 'V', N'Dev');
INSERT catalog.object_parameters (project_id, object_type, object_name, parameter_name, data_type, required, sensitive, value_type, default_value) VALUES (1, 20, 'Sales', 'ApiKey', 'String', 1, 1, 'V', N'top-secret');
INSERT catalog.object_parameters (project_id, object_type, object_name, parameter_name, data_type, required, sensitive, value_type, default_value) VALUES (1, 20, 'Sales', 'CM.Warehouse.ServerName', 'String', 0, 0, 'V', N'sql01');
INSERT catalog.object_parameters (project_id, object_type, object_name, parameter_name, data_type, required, sensitive, value_type, default_value) VALUES (1, 30, 'LoadSales.dtsx', 'ImportFolder', 'String', 1, 0, 'V', N'C:\Import');
INSERT catalog.object_parameters (project_id, object_type, object_name, parameter_name, data_type, required, sensitive, value_type, default_value) VALUES (1, 30, 'LoadSales.dtsx', 'BatchSize', 'Int32', 0, 0, 'V', 100);
INSERT catalog.object_parameters (project_id, object_type, object_name, parameter_name, data_type, required, sensitive, value_type, default_value) VALUES (1, 30, 'LoadSales.dtsx', 'FullLoad', 'Boolean', 0, 0, 'V', CAST(0 AS bit));
INSERT catalog.object_parameters (project_id, object_type, object_name, parameter_name, data_type, required, sensitive, value_type, default_value) VALUES (1, 30, 'LoadSales.dtsx', 'Since', 'DateTime', 0, 0, 'V', NULL);
INSERT catalog.object_parameters (project_id, object_type, object_name, parameter_name, data_type, required, sensitive, value_type, default_value) VALUES (1, 30, 'LoadSales.dtsx', 'MaxRows', 'Int64', 0, 0, 'V', NULL);
INSERT catalog.environments (folder_id, name) VALUES (1, 'Prod');
INSERT catalog.environment_variables (environment_id, name, type, sensitive, value) VALUES (1, 'Retries', 'Int16', 0, CAST(3 AS smallint));
INSERT catalog.environment_variables (environment_id, name, type, sensitive, value) VALUES (1, 'Password', 'String', 1, N'p@ss');
INSERT catalog.environment_references (project_id, reference_type, environment_name) VALUES (1, 'R', 'Prod');
SET IDENTITY_INSERT catalog.executions ON;
INSERT catalog.executions (execution_id, folder_name, project_name, package_name, status, start_time, end_time, executed_as_name, environment_name, use32bitruntime, server_name)
VALUES (42, 'ETL', 'Sales', 'LoadSales.dtsx', 4, DATEADD(minute, -30, SYSDATETIMEOFFSET()), DATEADD(minute, -27, SYSDATETIMEOFFSET()), 'CORP\svc', 'Prod', 0, 'SQL01');
SET IDENTITY_INSERT catalog.executions OFF;
INSERT catalog.event_messages (operation_id, message_time, message_type, message_source_name, package_name, execution_path, message) VALUES
	(42, SYSDATETIMEOFFSET(), 120, 'Load file', 'LoadSales.dtsx', '\Package\For each sales file\Load file', 'Cannot insert the value NULL into column ''OrderId''.'),
	(42, SYSDATETIMEOFFSET(), 120, 'LoadSales', 'LoadSales.dtsx', '\Package', 'Cannot insert the value NULL into column ''OrderId''.'),
	(42, SYSDATETIMEOFFSET(), 110, 'Load file', 'LoadSales.dtsx', '\Package\For each sales file\Load file', 'Truncation may occur.');
INSERT catalog.executables (executable_id, execution_id, executable_name, package_name) VALUES (1, 42, 'Load file', 'LoadSales.dtsx');
INSERT catalog.executable_statistics (execution_id, executable_id, execution_path, start_time, execution_duration, execution_result) VALUES (42, 1, '\Package\For each sales file\Load file', SYSDATETIMEOFFSET(), 1200, 1);
INSERT catalog.execution_parameter_values (execution_id, object_type, parameter_name, parameter_value, sensitive) VALUES (42, 30, 'BatchSize', 50, 0);
INSERT catalog.execution_parameter_values (execution_id, object_type, parameter_name, parameter_value, sensitive) VALUES (42, 20, 'ApiKey', N'top-secret', 1);
